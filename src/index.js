require('dotenv').config();
const express = require('express');
const path = require('node:path');
const sse = require('./sse');
const api = require('./api');
const config = require('./config');
const { createProxyMiddleware } = require('./proxy');

const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);

const app = express();

// SSE stream for real-time updates
app.get('/events', (req, res) => sse.subscribe(res));

// REST API (parse JSON body only for API routes)
app.use('/api', express.json(), api);

// Static web UI
app.use(express.static(path.join(__dirname, '..', 'public')));

// Proxy — must be last; reads config.upstreamUrl dynamically per request
app.all('/v1/*', createProxyMiddleware());

app.listen(PORT, () => {
  console.log(`Local proxy listening on http://localhost:${PORT}`);
  console.log(`Forwarding to upstream: ${config.upstreamUrl}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  if (process.env.PERSIST !== 'false') {
    console.log(`Persistence: ${process.env.DB_PATH || './proxy-history.db'}`);
  }
});
