const config = {
  mode: process.env.MODE || 'auto',        // 'auto' | 'manual'
  upstreamUrl: process.env.UPSTREAM_URL || 'http://127.0.0.1:8001',
};

module.exports = config;
