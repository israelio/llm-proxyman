const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');
const store = require('./store');
const sse = require('./sse');
const config = require('./config');

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {}
  return buffer;
}

function parseUsage(body) {
  let inputTokens = 0, outputTokens = 0, foundAny = false;

  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const json = JSON.parse(line.slice(6));
      // Anthropic: input tokens nested in message_start.message.usage
      if (json.type === 'message_start' && json.message?.usage) {
        const u = json.message.usage;
        inputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        foundAny = true;
      }
      // Anthropic: output tokens in message_delta.usage
      if (json.type === 'message_delta' && json.usage?.output_tokens != null) {
        outputTokens = json.usage.output_tokens;
        foundAny = true;
      }
      // OpenAI streaming: usage object without a .type field
      if (!json.type && json.usage) {
        return extractUsageFields(json.usage);
      }
    } catch {}
  }

  if (foundAny) {
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }

  // Non-streaming JSON response
  try {
    const json = JSON.parse(body);
    if (json.usage) return extractUsageFields(json.usage);
  } catch {}

  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
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

const ANTHROPIC_URL = 'https://api.anthropic.com';
const ANTHROPIC_MODEL_RE = /sonnet|opus|haiku/i;
const OPENAI_MODEL_RE = /^gpt-/i;

function resolveUpstreamUrl(model, overrideUrl, mitmHost) {
  if (overrideUrl) return overrideUrl;
  // MITM requests carry the original CONNECT hostname — forward there
  if (mitmHost) return `https://${mitmHost}`;
  if (config.mode === 'anthropic') return ANTHROPIC_URL;
  if (config.mode === 'auto') {
    if (ANTHROPIC_MODEL_RE.test(model || '')) return ANTHROPIC_URL;
    if (OPENAI_MODEL_RE.test(model || '')) return config.openaiUrl;
  }
  return config.upstreamUrl;
}

function createProxyMiddleware(overrideUrl) {
  return function proxyMiddleware(req, res) {
    const bodyChunks = [];
    req.on('data', c => bodyChunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks);

      let requestBody = null;
      let model = 'unknown';
      try {
        const reqEncoding = req.headers['content-encoding'];
        const bodyBuf = reqEncoding ? decompress(rawBody, reqEncoding) : rawBody;
        requestBody = JSON.parse(bodyBuf.toString());
        model = requestBody.model || 'unknown';
      } catch {}

      const mitmHost = req.headers['x-mitm-host'] || null;
      const upstream = new URL(resolveUpstreamUrl(model, overrideUrl, mitmHost));
      const isHttps = upstream.protocol === 'https:';
      const transport = isHttps ? https : http;

      const record = store.add({
        method: req.method,
        path: req.path || req.url,
        model,
        upstream: upstream.origin,
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
          'accept-encoding': 'identity', // disable compression so response is human-readable
        },
      };

      const upstreamReq = transport.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

        const resChunks = [];

        upstreamRes.on('data', (chunk) => {
          res.write(chunk);
          resChunks.push(chunk);
          // Stream raw text chunks for live display (best-effort; may be garbled if compressed)
          const text = chunk.toString();
          store.appendChunk(record.id, text);
          sse.emit('request:chunk', { id: record.id, chunk: text });
        });

        upstreamRes.on('end', () => {
          res.end();
          // Decompress full response body for logging/usage parsing
          const resEncoding = upstreamRes.headers['content-encoding'];
          const rawRes = Buffer.concat(resChunks);
          const bodyBuf = resEncoding ? decompress(rawRes, resEncoding) : rawRes;
          const fullBody = bodyBuf.toString('utf8');

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
