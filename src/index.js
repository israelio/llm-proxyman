require('dotenv').config();
const express = require('express');
const path = require('node:path');
const sse = require('./sse');
const api = require('./api');
const config = require('./config');
const { createProxyMiddleware } = require('./proxy');
const tls = require('node:tls');
const { setupCA, createConnectHandler, mitmHosts } = require('./mitm');

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

// Catch-all for MITM'd requests on non-standard paths (e.g. chatgpt.com/backend-api/*)
// Identified by loopback port in mitmHosts map — works for all keep-alive requests.
app.use((req, res, next) => {
  if (!mitmHosts.has(req.socket.remotePort)) return next();
  createProxyMiddleware()(req, res);
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
  if (!hostname) { socket.destroy(); return; }

  const upstream = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
    // Forward the upgrade request to the real server
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
