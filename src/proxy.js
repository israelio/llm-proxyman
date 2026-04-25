const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const store = require('./store');
const sse = require('./sse');

function parseUsage(body) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // Scan SSE data lines (streaming response)
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const json = JSON.parse(line.slice(6));
      if (json.usage) return extractUsageFields(json.usage);
    } catch {}
  }

  // Non-streaming JSON response
  try {
    const json = JSON.parse(body);
    if (json.usage) return extractUsageFields(json.usage);
  } catch {}

  return usage;
}

function extractUsageFields(u) {
  const input = u.prompt_tokens || u.input_tokens || 0;
  const output = u.completion_tokens || u.output_tokens || 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: u.total_tokens || input + output,
  };
}

function createProxyMiddleware(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  const isHttps = upstream.protocol === 'https:';
  const transport = isHttps ? https : http;

  return function proxyMiddleware(req, res) {
    const bodyChunks = [];
    req.on('data', c => bodyChunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks);

      let requestBody = null;
      let model = 'unknown';
      try {
        requestBody = JSON.parse(rawBody.toString());
        model = requestBody.model || 'unknown';
      } catch {}

      const record = store.add({
        method: req.method,
        path: req.path || req.url,
        model,
        request: requestBody || rawBody.toString(),
      });

      sse.emit('request:start', record);

      const options = {
        hostname: upstream.hostname,
        port: upstream.port || (isHttps ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: upstream.host,
          'content-length': rawBody.length,
        },
      };

      const upstreamReq = transport.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

        let fullBody = '';

        upstreamRes.on('data', (chunk) => {
          res.write(chunk);
          const text = chunk.toString();
          fullBody += text;
          store.appendChunk(record.id, text);
          sse.emit('request:chunk', { id: record.id, chunk: text });
        });

        upstreamRes.on('end', () => {
          res.end();
          const usage = parseUsage(fullBody);
          const durationMs = Date.now() - record._startTime;
          let parsedResponse = null;
          try { parsedResponse = JSON.parse(fullBody); } catch {}
          const updated = store.update(record.id, {
            status: 'complete',
            response: parsedResponse || fullBody,
            usage,
            durationMs,
          });
          sse.emit('request:complete', updated);
        });

        upstreamRes.on('error', (err) => {
          const durationMs = Date.now() - record._startTime;
          const updated = store.update(record.id, { status: 'error', error: err.message, durationMs });
          sse.emit('request:error', updated);
          if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      upstreamReq.on('error', (err) => {
        const durationMs = Date.now() - record._startTime;
        const updated = store.update(record.id, { status: 'error', error: err.message, durationMs });
        sse.emit('request:error', updated);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
        }
      });

      upstreamReq.write(rawBody);
      upstreamReq.end();
    });
  };
}

module.exports = { createProxyMiddleware };
