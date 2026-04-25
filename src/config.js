const fs = require('node:fs');

const SAVE_PATH = process.env.CONFIG_PATH || './proxy-config.json';

let saved = {};
try { saved = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8')); } catch {}

const config = {
  mode: saved.mode || process.env.MODE || 'auto',        // 'auto' | 'anthropic' | 'local'
  upstreamUrl: saved.upstreamUrl || process.env.UPSTREAM_URL || 'http://127.0.0.1:8001',
};

config.save = function () {
  try {
    fs.writeFileSync(SAVE_PATH, JSON.stringify({ mode: this.mode, upstreamUrl: this.upstreamUrl }));
  } catch (err) {
    console.error('Config save failed:', err.message);
  }
};

module.exports = config;
