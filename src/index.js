require('dotenv').config();
const express = require('express');
const path = require('node:path');
const sse = require('./sse');
const api = require('./api');
const { createProxyMiddleware } = require('./proxy');

const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://127.0.0.1:8001';

const app = express();

// SSE stream for real-time updates
app.get('/events', (req, res) => sse.subscribe(res));

// REST API (parse JSON body only for API routes)
app.use('/api', express.json(), api);

// Static web UI
app.use(express.static(path.join(__dirname, '..', 'public')));

// Proxy — must be last; do NOT use body-parsing middleware before this
app.all('/v1/*', createProxyMiddleware(UPSTREAM_URL));

app.listen(PORT, () => {
  console.log(`Local proxy listening on http://localhost:${PORT}`);
  console.log(`Forwarding to upstream: ${UPSTREAM_URL}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  if (process.env.PERSIST === 'true') {
    console.log(`Persistence enabled: ${process.env.DB_PATH || './proxy-history.db'}`);
  }
});
