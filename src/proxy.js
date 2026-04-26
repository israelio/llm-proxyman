const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');
const store = require('./store');
const sse = require('./sse');
const config = require('./config');
const { mitmHosts } = require('./mitm');

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
    if (encoding === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buffer);
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

function createProxyMiddleware(overrideUrlOrOpts) {
  const opts = typeof overrideUrlOrOpts === 'object' ? overrideUrlOrOpts : {};
  const overrideUrl = typeof overrideUrlOrOpts === 'string' ? overrideUrlOrOpts : undefined;
  const silent = opts.silent || false;
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
        if (!silent) console.log(`[PROXY] parsed model=${model} encoding=${reqEncoding} bodyKeys=${Object.keys(requestBody).join(',')}`);
      } catch (e) {
        if (!silent) console.log(`[PROXY] body parse failed: ${e.message} encoding=${req.headers['content-encoding']} rawLen=${rawBody.length}`);
      }

      // Look up MITM hostname by the incoming socket's remote port (loopback port).
      // This works for all requests on a keep-alive connection, not just the first one.
      const mitmHost = mitmHosts.get(req.socket.remotePort) || null;
      if (!silent) console.log(`[PROXY] ${req.method} ${req.url} model=${model} mitmHost=${mitmHost}`);
      const upstream = new URL(resolveUpstreamUrl(model, overrideUrl, mitmHost));
      const isHttps = upstream.protocol === 'https:';
      const transport = isHttps ? https : http;

      const requestContent = requestBody || (rawBody.length ? rawBody.toString() : null);
      const record = silent ? null : store.add({
        method: req.method,
        path: req.path || req.url,
        model,
        upstream: upstream.origin,
        request: requestContent,
      });

      if (record) sse.emit('request:start', record);

      // Build forwarded headers: strip internal proxy headers, fix host + content-length
      const forwardHeaders = { ...req.headers };
      delete forwardHeaders['x-mitm-host']; // internal — must not leak to upstream

      const options = {
        hostname: upstream.hostname,
        port: upstream.port || (isHttps ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: {
          ...forwardHeaders,
          host: upstream.host,
          'content-length': rawBody.length,
          // Keep original accept-encoding so client can decompress the response itself.
          // We decompress a copy for logging purposes in the 'end' handler below.
        },
      };

      // Deduplicated finalize — called once regardless of which path ends the request.
      // Drops the record entirely if both request and response are empty (GET noise).
      let done = false;
      const finalize = (status, extra = {}) => {
        if (done || silent) return;
        done = true;
        const durationMs = Date.now() - record._startTime;
        const hasContent = requestContent || extra.response;
        if (!hasContent && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          store.remove(record.id);
          return;
        }
        const updated = store.update(record.id, { status, durationMs, ...extra });
        sse.emit(`request:${status}`, updated);
      };

      const upstreamReq = transport.request(options, (upstreamRes) => {
        console.log(`[PROXY] <- ${upstreamRes.statusCode} for ${req.method} ${req.url} upstream=${upstream.origin}`);
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

        const resChunks = [];

        upstreamRes.on('data', (chunk) => {
          res.write(chunk);
          if (silent) return;
          resChunks.push(chunk);
          const text = chunk.toString();
          store.appendChunk(record.id, text);
          sse.emit('request:chunk', { id: record.id, chunk: text });
        });

        upstreamRes.on('end', () => {
          res.end();
          // Decompress full response for logging/usage parsing
          const resEncoding = upstreamRes.headers['content-encoding'];
          const rawRes = Buffer.concat(resChunks);
          const bodyBuf = resEncoding ? decompress(rawRes, resEncoding) : rawRes;
          const fullBody = bodyBuf.toString('utf8');
          const usage = parseUsage(fullBody);
          let parsedResponse = null;
          try { parsedResponse = JSON.parse(fullBody); } catch {}
          finalize('complete', { response: parsedResponse || fullBody, usage });
        });

        upstreamRes.on('error', (err) => {
          if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); }
          finalize('error', { error: err.message });
        });
      });

      upstreamReq.on('error', (err) => {
        console.log(`[PROXY] ERROR ${req.method} ${req.url} -> ${err.message} code=${err.code}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
        }
        finalize('error', { error: err.message });
      });

      // Abort upstream only if client truly disconnected (socket destroyed without
      // completing the HTTP exchange). req.complete means body was fully received,
      // so close after complete is normal — not a disconnect.
      req.on('close', () => {
        if (!req.complete && !res.headersSent) {
          upstreamReq.destroy();
          finalize('complete');
        }
      });

      upstreamReq.write(rawBody);
      upstreamReq.end();
    });
  };
}

module.exports = { createProxyMiddleware };
