#!/usr/bin/env node
require('dotenv').config();
const express = require('express');
const path = require('node:path');
const { execFile, exec } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const sse = require('./sse');
const api = require('./api');
const config = require('./config');
const { createProxyMiddleware } = require('./proxy');
const tls = require('node:tls');
const { setupCA, createConnectHandler, mitmHosts } = require('./mitm');
const { interceptCodexWs } = require('./ws-intercept');

const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);

// Generate CA cert if needed (prints trust command on first run)
const caCertPath = setupCA();

const app = express();

// SSE stream for real-time updates
app.get('/events', (req, res) => sse.subscribe(res));

// REST API (parse JSON body only for API routes)
app.use('/api', express.json(), api);

// Static web UI
app.use(express.static(path.join(__dirname, '..', 'public')));

// Proxy /v1/* — standard OpenAI/Anthropic paths
app.all('/v1/*', createProxyMiddleware());

// Fetch model name from upstream /v1/models
function fetchLocalModel() {
  return new Promise((resolve, reject) => {
    http.get(config.upstreamUrl + '/v1/models', { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const models = j.data || j.models || [];
          if (models.length > 0) resolve(models[0].id || models[0].name);
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Run osascript and return result
app.post('/api/osascript', (req, res) => {
  const { script } = req.body || {};
  if (!script) return res.status(400).json({ error: 'missing script' });
  execFile('osascript', ['-e', script], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const p = stdout.trim().replace(/\n$/, '');
    res.json({ ok: true, path: p });
  });
});

// Create a folder on the server
app.post('/api/mkdir', (req, res) => {
  const { dir } = req.body || {};
  if (!dir) return res.status(400).json({ error: 'missing dir' });
  const resolved = path.resolve(dir);
  fs.mkdir(resolved, { recursive: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, path: resolved });
  });
});

// Launch Claude Code or Codex in a new terminal window
app.post('/api/launch', async (req, res) => {
  const { tool, model, dir } = req.body || {};
  const proxyUrl = `http://127.0.0.1:${PORT}`;
  const cwd = dir ? path.resolve(dir) : null;
  let cmd, args, env;

  let launchCmd;
  if (tool === 'claude-local') {
    const modelName = model || await fetchLocalModel();
    if (!modelName) return res.status(502).json({ error: 'cannot reach upstream /v1/models' });
    launchCmd = `CLAUDECODE= ANTHROPIC_BASE_URL="${proxyUrl}" claude --model ${modelName} --dangerously-skip-permissions`;
  } else if (tool === 'claude') {
    launchCmd = `CLAUDECODE= ANTHROPIC_BASE_URL="${proxyUrl}" claude --dangerously-skip-permissions`;
  } else {
    launchCmd = `HTTP_PROXY="${proxyUrl}" HTTPS_PROXY="${proxyUrl}" codex`;
  }

  // Escape all double quotes for AppleScript string
  const escapedCmd = launchCmd.replace(/"/g, '\\"');
  const escapedCwd = cwd ? cwd.replace(/"/g, '\\"') : '';

  let shellCmd;
  if (cwd) {
    shellCmd = `cd \\"${escapedCwd}\\" && ${escapedCmd}`;
  } else {
    shellCmd = escapedCmd;
  }

  const script = [
    'tell application "Terminal"',
    `    do script "${shellCmd}"`,
    '    activate',
    'end tell',
  ].join('\n');

  cmd = 'osascript';
  args = ['-e', script];
  env = (tool === 'claude' || tool === 'claude-local') ? { ...process.env, CLAUDECODE: '' } : process.env;

  execFile(cmd, args, { env }, (err) => {
    if (err) {
      console.error('[LAUNCH] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true });
  });
});

// Catch-all for MITM'd requests — only log actual API calls, silence noise.
const API_PATHS = /^\/(v1\/|backend-api\/(codex\/responses|conversation|responses))/;
app.use((req, res, next) => {
  if (!mitmHosts.has(req.socket.remotePort)) return next();
  const silent = !API_PATHS.test(req.url);
  if (req.method === 'POST' || !silent) console.log(`[MITM-ROUTE] ${req.method} ${req.url} silent=${silent}`);
  else if (req.url.includes('backend-api')) console.log(`[MITM-ROUTE] ${req.method} ${req.url} silent=${silent}`);
  createProxyMiddleware({ silent })(req, res);
});

const server = app.listen(PORT, () => {
  console.log(`Local proxy listening on http://localhost:${PORT}`);
  console.log(`Forwarding to upstream: ${config.upstreamUrl}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`CA cert: ${caCertPath}`);
  if (process.env.PERSIST !== 'false') {
    console.log(`Persistence: ${process.env.DB_PATH || './proxy-history.db'}`);
  }
});

// HTTPS MITM — intercept CONNECT tunnels (e.g. from Codex via HTTPS_PROXY)
server.on('connect', createConnectHandler(PORT));

// WebSocket upgrade handler — tunnel wss:// upgrades to the real upstream.
// We can't inspect WS frames easily, so we just forward transparently.
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const hostname = mitmHosts.get(socket.remotePort);
  console.log(`[WS-UPGRADE] ${req.method} ${req.url} hostname=${hostname}`);
  if (!hostname) { socket.destroy(); return; }

  // Intercept codex API WebSockets to log request/response
  if (req.url.startsWith('/backend-api/codex/responses') || req.url.startsWith('/backend-api/conversation')) {
    interceptCodexWs(req, socket, head, hostname);
    return;
  }

  const upstream = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
    const headers = Object.entries(req.headers)
      .filter(([k]) => k !== 'x-mitm-host')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
});
