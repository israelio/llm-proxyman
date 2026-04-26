require('dotenv').config();
const express = require('express');
const path = require('node:path');
const sse = require('./sse');
const api = require('./api');
const config = require('./config');
const { createProxyMiddleware } = require('./proxy');
const { setupCA, createConnectHandler } = require('./mitm');

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
// X-Mitm-Host header is injected by the MITM handler and tells us where to forward.
// app.use (no path) is used because app.all('*') doesn't reliably match in Express 4.22+
app.use((req, res, next) => {
  if (!req.headers['x-mitm-host']) return next();
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
