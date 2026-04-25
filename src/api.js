const express = require('express');
const path = require('node:path');
const store = require('./store');
const config = require('./config');

const router = express.Router();

router.get('/requests', (req, res) => {
  const { search, model, status, from, to } = req.query;
  res.json(store.getAll({ search, model, status, from, to }));
});

router.get('/requests/:id', (req, res) => {
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

router.delete('/requests', (req, res) => {
  store.clear();
  res.json({ ok: true });
});

router.get('/stats', (req, res) => {
  res.json(store.getStats());
});

router.get('/export', (req, res) => {
  const { format = 'json', search, model, status, from, to } = req.query;
  const records = store.getAll({ search, model, status, from, to });

  if (format === 'csv') {
    const headers = ['id', 'timestamp', 'model', 'status', 'durationMs', 'inputTokens', 'outputTokens', 'totalTokens'];
    const rows = records.map(r =>
      [r.id, r.timestamp, r.model, r.status, r.durationMs,
        r.usage?.inputTokens, r.usage?.outputTokens, r.usage?.totalTokens]
        .map(v => JSON.stringify(v ?? '')).join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="proxy-history.csv"');
    return res.send([headers.join(','), ...rows].join('\n'));
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="proxy-history.json"');
  res.json(records);
});

router.get('/version', (req, res) => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  res.json({ version: pkg.version });
});

router.get('/config', (req, res) => {
  res.json({ mode: config.mode, upstreamUrl: config.upstreamUrl });
});

router.put('/config', (req, res) => {
  const { upstreamUrl, mode } = req.body || {};

  if (mode !== undefined) {
    if (!['auto', 'manual'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "auto" or "manual"' });
    }
    config.mode = mode;
  }

  if (upstreamUrl !== undefined) {
    if (typeof upstreamUrl !== 'string') {
      return res.status(400).json({ error: 'upstreamUrl must be a string' });
    }
    try { new URL(upstreamUrl); } catch {
      return res.status(400).json({ error: 'invalid URL' });
    }
    config.upstreamUrl = upstreamUrl;
  }

  res.json({ mode: config.mode, upstreamUrl: config.upstreamUrl });
});

module.exports = router;
