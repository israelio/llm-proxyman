const tls = require('node:tls');
const store = require('./store');
const sse = require('./sse');

function parseFrame(buf, offset = 0) {
  if (buf.length - offset < 2) return null;
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let pos = offset + 2;

  if (payloadLen === 126) {
    if (buf.length - pos < 2) return null;
    payloadLen = buf.readUInt16BE(pos);
    pos += 2;
  } else if (payloadLen === 127) {
    if (buf.length - pos < 8) return null;
    payloadLen = Number(buf.readBigUInt64BE(pos));
    pos += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buf.length - pos < 4) return null;
    maskKey = buf.slice(pos, pos + 4);
    pos += 4;
  }

  if (buf.length - pos < payloadLen) return null;

  let payload = buf.slice(pos, pos + payloadLen);
  if (masked) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return { opcode, payload, totalLen: pos + payloadLen - offset };
}

function extractFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const frame = parseFrame(buf, offset);
    if (!frame) break;
    frames.push(frame);
    offset += frame.totalLen;
  }
  return { frames, remainder: buf.slice(offset) };
}

function interceptCodexWs(req, clientSocket, head, hostname) {
  // Strip permessage-deflate so frames arrive uncompressed
  const headers = Object.entries(req.headers)
    .filter(([k]) => k !== 'x-mitm-host' && k !== 'host' && k !== 'sec-websocket-extensions')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');

  const upstream = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\nhost: ${hostname}\r\n${headers}\r\n\r\n`
    );
    if (head && head.length) upstream.write(head);
  });

  upstream.on('error', (err) => {
    console.log(`[WS] upstream error: ${err.message}`);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());

  let handshakeDone = false;
  let upstreamBuf = Buffer.alloc(0);
  let clientBuf = Buffer.alloc(0);

  // Per-response tracking: one store record per response.create → response.completed cycle
  let currentRecord = null;
  let currentRequest = null;
  let model = 'unknown';
  let outputText = ''; // accumulate from output_text.delta events

  upstream.on('data', (chunk) => {
    if (!handshakeDone) {
      upstreamBuf = Buffer.concat([upstreamBuf, chunk]);
      const headerEnd = upstreamBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerPart = upstreamBuf.slice(0, headerEnd + 4);
      clientSocket.write(headerPart);
      handshakeDone = true;

      const rest = upstreamBuf.slice(headerEnd + 4);
      upstreamBuf = Buffer.alloc(0);
      if (rest.length) processUpstream(rest);
      return;
    }
    processUpstream(chunk);
  });

  function processUpstream(data) {
    clientSocket.write(data);
    upstreamBuf = Buffer.concat([upstreamBuf, data]);
    const { frames, remainder } = extractFrames(upstreamBuf);
    upstreamBuf = remainder;
    for (const f of frames) {
      if (f.opcode === 1) handleUpstreamText(f.payload.toString('utf8'));
    }
  }

  clientSocket.on('data', (chunk) => {
    if (!handshakeDone) return;
    upstream.write(chunk);
    clientBuf = Buffer.concat([clientBuf, chunk]);
    const { frames, remainder } = extractFrames(clientBuf);
    clientBuf = remainder;
    for (const f of frames) {
      if (f.opcode === 1) handleClientText(f.payload.toString('utf8'));
    }
  });

  function handleClientText(text) {
    try {
      const json = JSON.parse(text);
      if (json.model) model = json.model;
      if (json.type === 'response.create') {
        currentRequest = json;
        outputText = '';
        currentRecord = store.add({
          method: 'WS',
          path: req.url,
          model,
          upstream: `wss://${hostname}`,
          request: json,
        });
        sse.emit('request:start', currentRecord);
        console.log(`[WS] response.create model=${model}`);
      }
    } catch {}
  }

  function handleUpstreamText(text) {
    if (!currentRecord) return;
    try {
      const json = JSON.parse(text);

      // Stream text deltas to UI
      if (json.type === 'response.output_text.delta' && json.delta) {
        outputText += json.delta;
        store.appendChunk(currentRecord.id, json.delta);
        sse.emit('request:chunk', { id: currentRecord.id, chunk: json.delta });
        return;
      }

      // Response completed — finalize the record
      if (json.type === 'response.completed' && json.response) {
        const resp = json.response;
        const usage = extractUsage(resp.usage);
        const durationMs = Date.now() - currentRecord._startTime;
        const updated = store.update(currentRecord.id, {
          status: 'complete',
          model,
          response: resp,
          usage,
          durationMs,
        });
        sse.emit('request:complete', updated);
        // Log output structure for debugging
        const outputTypes = (resp.output || []).map(o => `${o.type}(${(o.content||[]).map(c=>c.type).join(',')})`).join('; ');
        console.log(`[WS] response.completed model=${model} in=${usage.inputTokens} out=${usage.outputTokens} ${durationMs}ms outputs=[${outputTypes}]`);
        currentRecord = null;
        currentRequest = null;
      }
    } catch {}
  }

  clientSocket.on('close', () => upstream.destroy());
  upstream.on('close', () => clientSocket.destroy());
}

function extractUsage(u) {
  if (!u) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const input = u.prompt_tokens || u.input_tokens || 0;
  const output = u.completion_tokens || u.output_tokens || 0;
  return { inputTokens: input, outputTokens: output, totalTokens: u.total_tokens || input + output };
}

module.exports = { interceptCodexWs };
