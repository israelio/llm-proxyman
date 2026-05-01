# Local Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local HTTP proxy that intercepts Claude Code → LLM traffic and exposes a real-time web UI for inspecting all requests and responses.

**Architecture:** Single Node.js/Express process on port 8080. Proxy routes (`/v1/*`) forward to configurable upstream, capture traffic, and broadcast updates via SSE. Web UI (`/`) is a single HTML file consuming the SSE stream and REST API.

**Tech Stack:** Node.js, Express 4, `better-sqlite3` (optional persistence), `supertest` + `node:test` for testing.

---

## File Map

| File | Responsibility |
|---|---|
| `src/store.js` | In-memory record store; optional SQLite persistence |
| `src/sse.js` | SSE subscriber registry; emit events to browsers |
| `src/proxy.js` | Forward `/v1/*` to upstream; capture req/res; emit SSE events |
| `src/api.js` | REST API — list, filter, export, stats, clear |
| `src/index.js` | Express app entry point; wire all routes; start server |
| `public/index.html` | Single-file web UI (vanilla JS, no build) |
| `tests/store.test.js` | Unit tests for store |
| `tests/sse.test.js` | Unit tests for SSE broadcaster |
| `tests/api.test.js` | HTTP tests for REST API |
| `tests/proxy.test.js` | HTTP tests for proxy with mock upstream |
| `package.json` | Dependencies and scripts |
| `.env.example` | Documented env vars |

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `.env.example`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "local-proxy",
  "version": "1.0.0",
  "description": "Local proxy for Claude Code with real-time web UI",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test tests/store.test.js tests/sse.test.js tests/api.test.js tests/proxy.test.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  },
  "optionalDependencies": {
    "better-sqlite3": "^9.4.3"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Create .env.example**

```
# Port for proxy server and web UI
PROXY_PORT=8080

# Upstream LLM base URL
UPSTREAM_URL=http://127.0.0.1:8001

# Enable SQLite persistence (true/false)
PERSIST=false

# SQLite database file path (only used when PERSIST=true)
DB_PATH=./proxy-history.db

# Max in-memory records (oldest dropped when exceeded)
MAX_HISTORY=1000
```

- [ ] **Step 3: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, `package-lock.json` written. No errors.

- [ ] **Step 4: Commit**

```bash
git init
git add package.json .env.example
git commit -m "chore: project setup"
```

---

## Task 2: History Store

**Files:**
- Create: `src/store.js`
- Create: `tests/store.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/store.test.js`:

```javascript
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

describe('store', () => {
  beforeEach(() => store.clear());

  test('add returns record with pending status and generated id', () => {
    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: { messages: [] } });
    assert.equal(r.status, 'pending');
    assert.ok(r.id, 'id should be set');
    assert.ok(r.timestamp, 'timestamp should be set');
    assert.equal(r.model, 'gpt-4');
  });

  test('getAll returns all records', () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-3.5', request: {} });
    assert.equal(store.getAll().length, 2);
  });

  test('getAll filters by model', () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-3.5', request: {} });
    const result = store.getAll({ model: 'gpt-4' });
    assert.equal(result.length, 1);
    assert.equal(result[0].model, 'gpt-4');
  });

  test('getAll filters by status', () => {
    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.update(r.id, { status: 'complete' });
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    assert.equal(store.getAll({ status: 'complete' }).length, 1);
    assert.equal(store.getAll({ status: 'pending' }).length, 1);
  });

  test('getAll searches request content', () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: { messages: [{ role: 'user', content: 'hello world' }] } });
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: { messages: [{ role: 'user', content: 'goodbye' }] } });
    assert.equal(store.getAll({ search: 'hello' }).length, 1);
    assert.equal(store.getAll({ search: 'goodbye' }).length, 1);
    assert.equal(store.getAll({ search: 'world' }).length, 1);
  });

  test('update modifies record fields', () => {
    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.update(r.id, { status: 'complete', durationMs: 123 });
    const updated = store.getById(r.id);
    assert.equal(updated.status, 'complete');
    assert.equal(updated.durationMs, 123);
  });

  test('update returns null for unknown id', () => {
    const result = store.update('nonexistent', { status: 'complete' });
    assert.equal(result, null);
  });

  test('appendChunk adds chunk and sets streaming status', () => {
    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.appendChunk(r.id, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    const updated = store.getById(r.id);
    assert.equal(updated.status, 'streaming');
    assert.equal(updated.chunks.length, 1);
    assert.equal(updated.chunks[0], 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  });

  test('getById returns null for unknown id', () => {
    assert.equal(store.getById('nope'), null);
  });

  test('clear removes all records', () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.clear();
    assert.equal(store.getAll().length, 0);
  });

  test('getStats aggregates token counts', () => {
    const r1 = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.update(r1.id, { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
    const r2 = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.update(r2.id, { usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 } });
    const stats = store.getStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.inputTokens, 300);
    assert.equal(stats.outputTokens, 150);
    assert.equal(stats.totalTokens, 450);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/store.test.js
```

Expected: Error — `Cannot find module '../src/store'`

- [ ] **Step 3: Implement store.js**

Create `src/store.js`:

```javascript
const { randomUUID } = require('node:crypto');

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '1000', 10);

let records = [];

function add(data) {
  const record = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    status: 'pending',
    method: data.method,
    path: data.path,
    model: data.model,
    request: data.request,
    response: null,
    chunks: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    durationMs: null,
    error: null,
    _startTime: Date.now(),
  };
  records.unshift(record);
  if (records.length > MAX_HISTORY) records.pop();
  return record;
}

function update(id, changes) {
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return null;
  records[idx] = { ...records[idx], ...changes };
  return records[idx];
}

function appendChunk(id, chunk) {
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return null;
  records[idx].chunks.push(chunk);
  records[idx].status = 'streaming';
  return records[idx];
}

function getAll({ search, model, status, from, to } = {}) {
  let result = records;
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(r =>
      JSON.stringify(r.request).toLowerCase().includes(q) ||
      JSON.stringify(r.response || '').toLowerCase().includes(q)
    );
  }
  if (model) result = result.filter(r => r.model === model);
  if (status) result = result.filter(r => r.status === status);
  if (from) result = result.filter(r => r.timestamp >= from);
  if (to) result = result.filter(r => r.timestamp <= to);
  return result;
}

function getById(id) {
  return records.find(r => r.id === id) || null;
}

function clear() {
  records = [];
}

function getStats() {
  return {
    total: records.length,
    inputTokens: records.reduce((s, r) => s + (r.usage?.inputTokens || 0), 0),
    outputTokens: records.reduce((s, r) => s + (r.usage?.outputTokens || 0), 0),
    totalTokens: records.reduce((s, r) => s + (r.usage?.totalTokens || 0), 0),
  };
}

module.exports = { add, update, appendChunk, getAll, getById, clear, getStats };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/store.test.js
```

Expected: All tests pass, no failures.

- [ ] **Step 5: Commit**

```bash
git add src/store.js tests/store.test.js
git commit -m "feat: add history store"
```

---

## Task 3: SSE Broadcaster

**Files:**
- Create: `src/sse.js`
- Create: `tests/sse.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/sse.test.js`:

```javascript
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

// Fresh require each test to avoid shared state
function freshSse() {
  delete require.cache[require.resolve('../src/sse')];
  return require('../src/sse');
}

describe('sse', () => {
  test('subscribe writes 200 with SSE headers', () => {
    const sse = freshSse();
    const writeHead = mock.fn();
    const writes = [];
    const res = {
      writeHead,
      write: d => writes.push(d),
      on: (event, cb) => { if (event === 'close') res._close = cb; },
    };
    sse.subscribe(res);
    assert.equal(writeHead.mock.calls.length, 1);
    const [status, headers] = writeHead.mock.calls[0].arguments;
    assert.equal(status, 200);
    assert.equal(headers['Content-Type'], 'text/event-stream');
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.equal(headers['Connection'], 'keep-alive');
    assert.ok(writes.length > 0, 'should write initial keepalive');
  });

  test('emit sends named event with JSON data to subscribers', () => {
    const sse = freshSse();
    const received = [];
    const res = {
      writeHead: () => {},
      write: d => received.push(d),
      on: (event, cb) => { if (event === 'close') res._close = cb; },
    };
    sse.subscribe(res);
    sse.emit('request:start', { id: 'abc', model: 'gpt-4' });
    const event = received.find(d => d.includes('request:start'));
    assert.ok(event, 'event not found in writes');
    assert.ok(event.includes('"id":"abc"'));
    assert.ok(event.includes('"model":"gpt-4"'));
  });

  test('client removed from subscribers on close', () => {
    const sse = freshSse();
    const received = [];
    const res = {
      writeHead: () => {},
      write: d => received.push(d),
      on: (event, cb) => { if (event === 'close') res._close = cb; },
    };
    sse.subscribe(res);
    const beforeCount = received.length;
    res._close(); // simulate disconnect
    sse.emit('request:start', { id: 'xyz' });
    assert.equal(received.length, beforeCount, 'should not receive events after close');
  });

  test('emit to multiple subscribers', () => {
    const sse = freshSse();
    const received1 = [];
    const received2 = [];
    const makeRes = (received) => ({
      writeHead: () => {},
      write: d => received.push(d),
      on: (event, cb) => {},
    });
    sse.subscribe(makeRes(received1));
    sse.subscribe(makeRes(received2));
    sse.emit('ping', { ok: true });
    assert.ok(received1.some(d => d.includes('ping')));
    assert.ok(received2.some(d => d.includes('ping')));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/sse.test.js
```

Expected: Error — `Cannot find module '../src/sse'`

- [ ] **Step 3: Implement sse.js**

Create `src/sse.js`:

```javascript
let clients = new Set();

function subscribe(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': keepalive\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

module.exports = { subscribe, emit };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/sse.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sse.js tests/sse.test.js
git commit -m "feat: add SSE broadcaster"
```

---

## Task 4: Proxy Middleware

**Files:**
- Create: `src/proxy.js`
- Create: `tests/proxy.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/proxy.test.js`:

```javascript
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const supertest = require('supertest');
const express = require('express');
const store = require('../src/store');

describe('proxy', () => {
  let mockUpstream;
  let upstreamPort;
  let app;

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}

        if (body.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Transfer-Encoding': 'chunked',
          });
          res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'hello' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
        }
      });
    });

    await new Promise(resolve => mockUpstream.listen(0, resolve));
    upstreamPort = mockUpstream.address().port;

    const { createProxyMiddleware } = require('../src/proxy');
    app = express();
    app.all('/v1/*', createProxyMiddleware(`http://127.0.0.1:${upstreamPort}`));
  });

  after(() => mockUpstream.close());
  beforeEach(() => store.clear());

  test('proxies non-streaming request and returns upstream response', async () => {
    const res = await supertest(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.ok(res.body.choices, 'response should have choices');
  });

  test('records request in store with model and pending→complete status', async () => {
    await supertest(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', stream: false, messages: [] });
    await new Promise(r => setTimeout(r, 50));
    const records = store.getAll();
    assert.equal(records.length, 1);
    assert.equal(records[0].model, 'gpt-4');
    assert.equal(records[0].status, 'complete');
    assert.equal(records[0].path, '/v1/chat/completions');
  });

  test('captures token usage from non-streaming response', async () => {
    await supertest(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', stream: false, messages: [] });
    await new Promise(r => setTimeout(r, 50));
    const records = store.getAll();
    assert.equal(records[0].usage.inputTokens, 10);
    assert.equal(records[0].usage.outputTokens, 5);
    assert.equal(records[0].usage.totalTokens, 15);
  });

  test('records durationMs on completion', async () => {
    await supertest(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', stream: false, messages: [] });
    await new Promise(r => setTimeout(r, 50));
    const records = store.getAll();
    assert.ok(records[0].durationMs >= 0, 'durationMs should be set');
  });

  test('captures token usage from streaming response', async () => {
    await supertest(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', stream: true, messages: [] });
    await new Promise(r => setTimeout(r, 50));
    const records = store.getAll();
    assert.equal(records[0].status, 'complete');
    assert.equal(records[0].usage.inputTokens, 10);
    assert.equal(records[0].usage.totalTokens, 15);
  });

  test('returns 502 when upstream is unreachable', async () => {
    const { createProxyMiddleware } = require('../src/proxy');
    const badApp = express();
    badApp.all('/v1/*', createProxyMiddleware('http://127.0.0.1:1'));
    const res = await supertest(badApp)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [] });
    assert.equal(res.status, 502);
  });

  test('records error status when upstream unreachable', async () => {
    const { createProxyMiddleware } = require('../src/proxy');
    const badApp = express();
    badApp.all('/v1/*', createProxyMiddleware('http://127.0.0.1:1'));
    await supertest(badApp)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [] });
    await new Promise(r => setTimeout(r, 50));
    const records = store.getAll();
    assert.equal(records[0].status, 'error');
    assert.ok(records[0].error, 'error message should be set');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/proxy.test.js
```

Expected: Error — `Cannot find module '../src/proxy'`

- [ ] **Step 3: Implement proxy.js**

Create `src/proxy.js`:

```javascript
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const store = require('./store');
const sse = require('./sse');

function parseUsage(body) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // Scan SSE data lines (streaming response)
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const json = JSON.parse(line.slice(6));
      if (json.usage) return extractUsageFields(json.usage);
    } catch {}
  }

  // Non-streaming JSON response
  try {
    const json = JSON.parse(body);
    if (json.usage) return extractUsageFields(json.usage);
  } catch {}

  return usage;
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

function createProxyMiddleware(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  const isHttps = upstream.protocol === 'https:';
  const transport = isHttps ? https : http;

  return function proxyMiddleware(req, res) {
    const bodyChunks = [];
    req.on('data', c => bodyChunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks);

      let requestBody = null;
      let model = 'unknown';
      try {
        requestBody = JSON.parse(rawBody.toString());
        model = requestBody.model || 'unknown';
      } catch {}

      const record = store.add({
        method: req.method,
        path: req.path || req.url,
        model,
        request: requestBody || rawBody.toString(),
      });

      sse.emit('request:start', record);

      const options = {
        hostname: upstream.hostname,
        port: upstream.port || (isHttps ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: upstream.host,
          'content-length': rawBody.length,
        },
      };

      const upstreamReq = transport.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

        let fullBody = '';

        upstreamRes.on('data', (chunk) => {
          res.write(chunk);
          const text = chunk.toString();
          fullBody += text;
          store.appendChunk(record.id, text);
          sse.emit('request:chunk', { id: record.id, chunk: text });
        });

        upstreamRes.on('end', () => {
          res.end();
          const usage = parseUsage(fullBody);
          const durationMs = Date.now() - record._startTime;
          let parsedResponse = null;
          try { parsedResponse = JSON.parse(fullBody); } catch {}
          const updated = store.update(record.id, {
            status: 'complete',
            response: parsedResponse || fullBody,
            usage,
            durationMs,
          });
          sse.emit('request:complete', updated);
        });

        upstreamRes.on('error', (err) => {
          const durationMs = Date.now() - record._startTime;
          const updated = store.update(record.id, { status: 'error', error: err.message, durationMs });
          sse.emit('request:error', updated);
          if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      upstreamReq.on('error', (err) => {
        const durationMs = Date.now() - record._startTime;
        const updated = store.update(record.id, { status: 'error', error: err.message, durationMs });
        sse.emit('request:error', updated);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
        }
      });

      upstreamReq.write(rawBody);
      upstreamReq.end();
    });
  };
}

module.exports = { createProxyMiddleware };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/proxy.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/proxy.js tests/proxy.test.js
git commit -m "feat: add proxy middleware"
```

---

## Task 5: REST API

**Files:**
- Create: `src/api.js`
- Create: `tests/api.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/api.test.js`:

```javascript
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const express = require('express');
const store = require('../src/store');
const api = require('../src/api');

const app = express();
app.use(express.json());
app.use('/api', api);

describe('api', () => {
  beforeEach(() => store.clear());

  test('GET /api/requests returns empty array', async () => {
    const res = await supertest(app).get('/api/requests');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('GET /api/requests returns records', async () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    const res = await supertest(app).get('/api/requests');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].model, 'gpt-4');
  });

  test('GET /api/requests?model= filters by model', async () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-3.5', request: {} });
    const res = await supertest(app).get('/api/requests?model=gpt-4');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].model, 'gpt-4');
  });

  test('GET /api/requests?status= filters by status', async () => {
    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.update(r.id, { status: 'complete' });
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    const res = await supertest(app).get('/api/requests?status=complete');
    assert.equal(res.body.length, 1);
  });

  test('GET /api/requests?search= filters by content', async () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: { messages: [{ content: 'unique-xyz' }] } });
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: { messages: [{ content: 'other' }] } });
    const res = await supertest(app).get('/api/requests?search=unique-xyz');
    assert.equal(res.body.length, 1);
  });

  test('GET /api/requests/:id returns record', async () => {
    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    const res = await supertest(app).get(`/api/requests/${r.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, r.id);
  });

  test('GET /api/requests/:id returns 404 for unknown id', async () => {
    const res = await supertest(app).get('/api/requests/nonexistent');
    assert.equal(res.status, 404);
  });

  test('DELETE /api/requests clears all history', async () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    const res = await supertest(app).delete('/api/requests');
    assert.equal(res.status, 200);
    assert.equal(store.getAll().length, 0);
  });

  test('GET /api/stats returns aggregate counts', async () => {
    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.update(r.id, { usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
    const res = await supertest(app).get('/api/stats');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.totalTokens, 30);
  });

  test('GET /api/export?format=json returns JSON attachment', async () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    const res = await supertest(app).get('/api/export?format=json');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-disposition'].includes('proxy-history.json'));
    assert.equal(res.body.length, 1);
  });

  test('GET /api/export?format=csv returns CSV attachment', async () => {
    store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    const res = await supertest(app).get('/api/export?format=csv');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('proxy-history.csv'));
    const lines = res.text.trim().split('\n');
    assert.equal(lines.length, 2); // header + 1 data row
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/api.test.js
```

Expected: Error — `Cannot find module '../src/api'`

- [ ] **Step 3: Implement api.js**

Create `src/api.js`:

```javascript
const express = require('express');
const store = require('./store');

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

module.exports = router;
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/api.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api.js tests/api.test.js
git commit -m "feat: add REST API"
```

---

## Task 6: Entry Point

**Files:**
- Create: `src/index.js`

- [ ] **Step 1: Create src/index.js**

```javascript
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
```

- [ ] **Step 2: Run all tests to confirm nothing broke**

```bash
npm test
```

Expected: All tests pass across all 4 test files.

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: add entry point"
```

---

## Task 7: Web UI

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: Create public/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local Proxy</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'SF Mono',Monaco,monospace;background:#111;color:#d4d4d4;height:100vh;display:flex;flex-direction:column;overflow:hidden;font-size:13px}
.toolbar{display:flex;gap:8px;padding:8px 12px;background:#1a1a1a;border-bottom:1px solid #2a2a2a;align-items:center;flex-wrap:wrap}
.toolbar input,.toolbar select{background:#252525;border:1px solid #3a3a3a;color:#d4d4d4;padding:4px 8px;border-radius:4px;font-family:inherit;font-size:12px}
.toolbar input{width:180px}
.toolbar input:focus,.toolbar select:focus{outline:none;border-color:#4a9eff}
.btn{background:#252525;border:1px solid #3a3a3a;color:#d4d4d4;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px}
.btn:hover{background:#2f2f2f;border-color:#555}
.btn.danger{border-color:#5a2222;color:#ff6b6b}
.btn.danger:hover{background:#2a1111}
.conn{margin-left:auto;font-size:11px}
.conn.on{color:#4ec94e}
.conn.off{color:#ff6b6b}
.main{display:flex;flex:1;overflow:hidden}
.list-panel{width:300px;min-width:220px;border-right:1px solid #2a2a2a;display:flex;flex-direction:column;overflow:hidden}
.list-head{padding:6px 12px;font-size:11px;color:#666;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between}
.req-list{flex:1;overflow-y:auto}
.req-item{padding:8px 12px;border-bottom:1px solid #1e1e1e;cursor:pointer;user-select:none}
.req-item:hover{background:#1a1a1a}
.req-item.active{background:#1e2a3a}
.req-item .model{font-size:12px;font-weight:600;color:#e0e0e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.req-item .meta{font-size:11px;color:#555;margin-top:2px;display:flex;gap:6px;align-items:center}
.badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600}
.badge.pending{background:#2a2a00;color:#cccc00}
.badge.streaming{background:#002a12;color:#33dd77;animation:pulse 1s infinite}
.badge.complete{background:#001a2a;color:#4499ff}
.badge.error{background:#2a0000;color:#ff5555}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.stats-bar{padding:6px 12px;font-size:11px;color:#555;border-top:1px solid #2a2a2a}
.detail-panel{flex:1;display:flex;flex-direction:column;overflow:hidden}
.empty{flex:1;display:flex;align-items:center;justify-content:center;color:#333;font-size:13px}
.tabs{display:flex;padding:0 12px;border-bottom:1px solid #2a2a2a;background:#161616;flex-shrink:0}
.tab{padding:8px 14px;cursor:pointer;font-size:12px;color:#666;border-bottom:2px solid transparent}
.tab:hover{color:#aaa}
.tab.active{color:#d4d4d4;border-bottom-color:#4a9eff}
.tab-body{flex:1;overflow-y:auto;padding:12px}
.pane{display:none}
.pane.active{display:block}
pre{background:#181818;border:1px solid #2a2a2a;padding:12px;border-radius:4px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;line-height:1.5}
.stream-box{background:#181818;border:1px solid #2a2a2a;padding:12px;border-radius:4px;font-size:12px;min-height:80px;white-space:pre-wrap;word-break:break-all;line-height:1.5}
.stream-cursor{display:inline-block;width:8px;height:13px;background:#4a9eff;animation:blink .7s step-end infinite;vertical-align:text-bottom}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.tok-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.tok-card{background:#181818;border:1px solid #2a2a2a;border-radius:4px;padding:14px;text-align:center}
.tok-card .val{font-size:28px;font-weight:700;color:#4a9eff}
.tok-card .lbl{font-size:11px;color:#555;margin-top:4px}
.tok-meta{font-size:12px;color:#666;line-height:1.8}
.copy-btn{float:right;font-size:10px;padding:2px 6px;background:#252525;border:1px solid #3a3a3a;color:#888;border-radius:3px;cursor:pointer;margin-top:-2px}
.copy-btn:hover{color:#d4d4d4}
.req-detail-header{font-size:11px;color:#555;margin-bottom:8px}
</style>
</head>
<body>
<div class="toolbar">
  <input id="q" type="text" placeholder="Search messages...">
  <select id="mf"><option value="">All models</option></select>
  <select id="sf">
    <option value="">All status</option>
    <option value="complete">Complete</option>
    <option value="streaming">Streaming</option>
    <option value="error">Error</option>
    <option value="pending">Pending</option>
  </select>
  <button class="btn" onclick="doExport('json')">Export JSON</button>
  <button class="btn" onclick="doExport('csv')">Export CSV</button>
  <button class="btn danger" onclick="doClear()">Clear</button>
  <span id="cs" class="conn off">● Disconnected</span>
</div>
<div class="main">
  <div class="list-panel">
    <div class="list-head">
      <span id="rc">0 requests</span>
      <span id="st">0 tokens</span>
    </div>
    <div class="req-list" id="rl"></div>
    <div class="stats-bar" id="sb">In: 0 · Out: 0 · Total: 0</div>
  </div>
  <div class="detail-panel" id="dp">
    <div class="empty">Select a request to inspect</div>
  </div>
</div>
<script>
const records = {};
const streaming = {};
let sel = null;

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(ts) {
  return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function extractText(chunk) {
  let out = '';
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const j = JSON.parse(line.slice(6));
      if (j.choices?.[0]?.delta?.content) out += j.choices[0].delta.content;
      else if (j.delta?.text) out += j.delta.text;
      else if (j.type === 'content_block_delta' && j.delta?.text) out += j.delta.text;
    } catch {}
  }
  return out;
}

function filteredRecords() {
  const q = document.getElementById('q').value.toLowerCase();
  const mf = document.getElementById('mf').value;
  const sf = document.getElementById('sf').value;
  return Object.values(records)
    .filter(r => !mf || r.model === mf)
    .filter(r => !sf || r.status === sf)
    .filter(r => !q || JSON.stringify(r.request).toLowerCase().includes(q) || JSON.stringify(r.response||'').toLowerCase().includes(q))
    .sort((a,b) => b.timestamp.localeCompare(a.timestamp));
}

function renderList() {
  const fr = filteredRecords();
  document.getElementById('rl').innerHTML = fr.map(r => `
    <div class="req-item${r.id===sel?' active':''}" onclick="pick('${r.id}')">
      <div class="model">${esc(r.model)}</div>
      <div class="meta">
        <span class="badge ${r.status}">${r.status}</span>
        <span>${fmt(r.timestamp)}</span>
        <span>${r.durationMs != null ? r.durationMs+'ms' : '…'}</span>
        <span>${r.usage?.totalTokens||0}t</span>
      </div>
    </div>`).join('');
  document.getElementById('rc').textContent = `${fr.length} requests`;

  // sync model filter options
  const mf = document.getElementById('mf');
  const cur = mf.value;
  const models = [...new Set(Object.values(records).map(r=>r.model))].filter(Boolean);
  mf.innerHTML = '<option value="">All models</option>' + models.map(m=>`<option${m===cur?' selected':''}>${esc(m)}</option>`).join('');

  updateStats();
}

function updateStats() {
  const all = Object.values(records);
  const inp = all.reduce((s,r)=>s+(r.usage?.inputTokens||0),0);
  const out = all.reduce((s,r)=>s+(r.usage?.outputTokens||0),0);
  document.getElementById('sb').textContent = `In: ${inp} · Out: ${out} · Total: ${inp+out}`;
  document.getElementById('st').textContent = `${inp+out} tokens`;
}

function pick(id) {
  sel = id;
  renderList();
  renderDetail(records[id]);
}

function activeTab() {
  return document.querySelector('#dp .tab.active')?.dataset.tab || 'response';
}

function renderDetail(r) {
  const tab = activeTab();
  const isLive = r.status === 'pending' || r.status === 'streaming';
  const liveContent = streaming[r.id] || '';
  const dp = document.getElementById('dp');
  dp.innerHTML = `
    <div class="tabs">
      <div class="tab${tab==='request'?' active':''}" data-tab="request" onclick="switchTab('request')">Request</div>
      <div class="tab${tab==='response'?' active':''}" data-tab="response" onclick="switchTab('response')">Response</div>
      <div class="tab${tab==='tokens'?' active':''}" data-tab="tokens" onclick="switchTab('tokens')">Tokens</div>
      <div class="tab${tab==='raw'?' active':''}" data-tab="raw" onclick="switchTab('raw')">Raw</div>
    </div>
    <div class="tab-body">
      <div id="pane-request" class="pane${tab==='request'?' active':''}">
        <div class="req-detail-header">${esc(r.method)} ${esc(r.path)} · ${fmt(r.timestamp)}</div>
        <pre>${esc(JSON.stringify(r.request,null,2))}</pre>
      </div>
      <div id="pane-response" class="pane${tab==='response'?' active':''}">
        ${isLive
          ? `<div class="stream-box" id="sb-live">${esc(liveContent)}<span class="stream-cursor"></span></div>`
          : r.status === 'error'
            ? `<pre style="color:#ff5555">${esc(r.error||'Unknown error')}</pre>`
            : `<pre>${esc(liveContent || JSON.stringify(r.response,null,2))}</pre>`
        }
      </div>
      <div id="pane-tokens" class="pane${tab==='tokens'?' active':''}">
        <div class="tok-grid">
          <div class="tok-card"><div class="val">${r.usage?.inputTokens||0}</div><div class="lbl">Input Tokens</div></div>
          <div class="tok-card"><div class="val">${r.usage?.outputTokens||0}</div><div class="lbl">Output Tokens</div></div>
          <div class="tok-card"><div class="val">${r.usage?.totalTokens||0}</div><div class="lbl">Total Tokens</div></div>
        </div>
        <div class="tok-meta">
          Model: ${esc(r.model)}<br>
          Duration: ${r.durationMs != null ? r.durationMs+'ms' : 'in progress'}<br>
          Status: ${r.status}<br>
          Time: ${new Date(r.timestamp).toLocaleString()}
        </div>
      </div>
      <div id="pane-raw" class="pane${tab==='raw'?' active':''}">
        <button class="copy-btn" onclick="copyRaw()">Copy</button>
        <pre id="raw-pre">${esc(JSON.stringify({request:r.request,response:r.response,chunks:r.chunks,usage:r.usage},null,2))}</pre>
      </div>
    </div>`;
}

function updateLive() {
  const el = document.getElementById('sb-live');
  if (el && sel) {
    el.innerHTML = esc(streaming[sel]||'') + '<span class="stream-cursor"></span>';
  }
}

function switchTab(tab) {
  document.querySelectorAll('#dp .tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  document.querySelectorAll('#dp .pane').forEach(p=>p.classList.toggle('active',p.id===`pane-${tab}`));
}

function copyRaw() {
  const el = document.getElementById('raw-pre');
  if (el) navigator.clipboard.writeText(el.textContent).catch(()=>{});
}

function doExport(fmt) {
  const q = document.getElementById('q').value;
  const mf = document.getElementById('mf').value;
  const sf = document.getElementById('sf').value;
  const p = new URLSearchParams({format:fmt});
  if (q) p.set('search',q);
  if (mf) p.set('model',mf);
  if (sf) p.set('status',sf);
  window.location.href = `/api/export?${p}`;
}

function doClear() {
  if (!confirm('Clear all request history?')) return;
  fetch('/api/requests',{method:'DELETE'}).then(()=>{
    Object.keys(records).forEach(k=>delete records[k]);
    Object.keys(streaming).forEach(k=>delete streaming[k]);
    sel = null;
    renderList();
    document.getElementById('dp').innerHTML = '<div class="empty">Select a request to inspect</div>';
  });
}

// SSE
let es;
function connect() {
  es = new EventSource('/events');
  es.onopen = () => { document.getElementById('cs').textContent='● Connected'; document.getElementById('cs').className='conn on'; };
  es.onerror = () => { document.getElementById('cs').textContent='● Disconnected'; document.getElementById('cs').className='conn off'; setTimeout(connect,3000); };

  es.addEventListener('request:start', e => {
    const r = JSON.parse(e.data);
    records[r.id] = r;
    streaming[r.id] = '';
    renderList();
  });

  es.addEventListener('request:chunk', e => {
    const {id, chunk} = JSON.parse(e.data);
    if (records[id]) records[id].status = 'streaming';
    streaming[id] = (streaming[id]||'') + extractText(chunk);
    if (sel === id) updateLive();
    else renderList();
  });

  es.addEventListener('request:complete', e => {
    const r = JSON.parse(e.data);
    records[r.id] = r;
    renderList();
    if (sel === r.id) renderDetail(r);
  });

  es.addEventListener('request:error', e => {
    const r = JSON.parse(e.data);
    records[r.id] = r;
    renderList();
    if (sel === r.id) renderDetail(r);
  });
}

// Filters
['q','mf','sf'].forEach(id => document.getElementById(id).addEventListener('input', renderList));
document.getElementById('sf').addEventListener('change', renderList);

// Boot
fetch('/api/requests')
  .then(r=>r.json())
  .then(data => {
    data.forEach(r => { records[r.id] = r; streaming[r.id] = ''; });
    renderList();
  });

connect();
</script>
</body>
</html>
```

- [ ] **Step 2: Start the proxy and verify manually**

```bash
npm start
```

Expected output:
```
Local proxy listening on http://localhost:8080
Forwarding to upstream: http://127.0.0.1:8001
Web UI: http://localhost:8080
```

Open `http://localhost:8080` in browser. Verify:
- Page loads with toolbar, empty list panel, detail panel with "Select a request to inspect"
- `● Connected` appears in top-right
- No console errors in browser devtools

- [ ] **Step 3: Send a test request through the proxy**

```bash
curl -s -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[{"role":"user","content":"hello"}]}'
```

Expected: request appears in web UI list immediately, click it to see request JSON in Request tab.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add web UI"
```

---

## Task 8: SQLite Persistence

**Files:**
- Modify: `src/store.js`
- Create: `tests/sqlite.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/sqlite.test.js`:

```javascript
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'test-persist.db');

describe('sqlite persistence', () => {
  before(() => {
    // ensure clean slate
    try { fs.unlinkSync(DB_PATH); } catch {}
    process.env.PERSIST = 'true';
    process.env.DB_PATH = DB_PATH;
  });

  after(() => {
    process.env.PERSIST = 'false';
    delete process.env.DB_PATH;
    try { fs.unlinkSync(DB_PATH); } catch {}
  });

  test('persists completed records to SQLite', async () => {
    delete require.cache[require.resolve('../src/store')];
    const store = require('../src/store');
    store.clear();

    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: { messages: [] } });
    store.update(r.id, {
      status: 'complete',
      durationMs: 100,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      response: { choices: [] },
    });

    // Reload store from SQLite
    delete require.cache[require.resolve('../src/store')];
    const store2 = require('../src/store');
    const records = store2.getAll();
    assert.equal(records.length, 1, 'should have 1 record after reload');
    assert.equal(records[0].model, 'gpt-4');
    assert.equal(records[0].status, 'complete');
    assert.equal(records[0].usage.totalTokens, 15);
  });

  test('clear also deletes from SQLite', async () => {
    delete require.cache[require.resolve('../src/store')];
    const store = require('../src/store');

    const r = store.add({ method: 'POST', path: '/v1/chat/completions', model: 'gpt-4', request: {} });
    store.update(r.id, { status: 'complete', durationMs: 50, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, response: {} });
    store.clear();

    delete require.cache[require.resolve('../src/store')];
    const store3 = require('../src/store');
    assert.equal(store3.getAll().length, 0);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
node --test tests/sqlite.test.js
```

Expected: Tests fail (SQLite logic not yet in store.js).

- [ ] **Step 3: Add SQLite persistence to store.js**

Replace the full content of `src/store.js` with:

```javascript
const { randomUUID } = require('node:crypto');

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '1000', 10);

let records = [];
let db = null;

function initDb() {
  if (process.env.PERSIST !== 'true') return;
  try {
    const Database = require('better-sqlite3');
    db = new Database(process.env.DB_PATH || './proxy-history.db');
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        method TEXT,
        path TEXT,
        model TEXT,
        status TEXT,
        duration_ms INTEGER,
        request_json TEXT,
        response_json TEXT,
        chunks_json TEXT,
        usage_json TEXT,
        error TEXT
      )
    `);
    const rows = db.prepare(
      'SELECT * FROM requests ORDER BY timestamp DESC LIMIT ?'
    ).all(MAX_HISTORY);
    records = rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      method: row.method,
      path: row.path,
      model: row.model,
      status: row.status,
      durationMs: row.duration_ms,
      request: tryParse(row.request_json),
      response: tryParse(row.response_json),
      chunks: tryParse(row.chunks_json) || [],
      usage: tryParse(row.usage_json) || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      error: row.error,
      _startTime: Date.now(),
    }));
  } catch (err) {
    console.error('SQLite init failed:', err.message);
    db = null;
  }
}

function tryParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

const insertStmt = () => db && db.prepare(`
  INSERT OR REPLACE INTO requests
    (id, timestamp, method, path, model, status, duration_ms,
     request_json, response_json, chunks_json, usage_json, error)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);

function persistRecord(r) {
  if (!db) return;
  try {
    insertStmt().run(
      r.id, r.timestamp, r.method, r.path, r.model, r.status, r.durationMs,
      JSON.stringify(r.request), JSON.stringify(r.response),
      JSON.stringify(r.chunks), JSON.stringify(r.usage), r.error
    );
  } catch (err) {
    console.error('SQLite write failed:', err.message);
  }
}

function add(data) {
  const record = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    status: 'pending',
    method: data.method,
    path: data.path,
    model: data.model,
    request: data.request,
    response: null,
    chunks: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    durationMs: null,
    error: null,
    _startTime: Date.now(),
  };
  records.unshift(record);
  if (records.length > MAX_HISTORY) records.pop();
  return record;
}

function update(id, changes) {
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return null;
  records[idx] = { ...records[idx], ...changes };
  if (changes.status === 'complete' || changes.status === 'error') {
    persistRecord(records[idx]);
  }
  return records[idx];
}

function appendChunk(id, chunk) {
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return null;
  records[idx].chunks.push(chunk);
  records[idx].status = 'streaming';
  return records[idx];
}

function getAll({ search, model, status, from, to } = {}) {
  let result = records;
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(r =>
      JSON.stringify(r.request).toLowerCase().includes(q) ||
      JSON.stringify(r.response || '').toLowerCase().includes(q)
    );
  }
  if (model) result = result.filter(r => r.model === model);
  if (status) result = result.filter(r => r.status === status);
  if (from) result = result.filter(r => r.timestamp >= from);
  if (to) result = result.filter(r => r.timestamp <= to);
  return result;
}

function getById(id) {
  return records.find(r => r.id === id) || null;
}

function clear() {
  records = [];
  if (db) {
    try { db.prepare('DELETE FROM requests').run(); } catch {}
  }
}

function getStats() {
  return {
    total: records.length,
    inputTokens: records.reduce((s, r) => s + (r.usage?.inputTokens || 0), 0),
    outputTokens: records.reduce((s, r) => s + (r.usage?.outputTokens || 0), 0),
    totalTokens: records.reduce((s, r) => s + (r.usage?.totalTokens || 0), 0),
  };
}

initDb();

module.exports = { add, update, appendChunk, getAll, getById, clear, getStats };
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: All tests pass (store, sse, api, proxy, sqlite).

Note: `sqlite.test.js` is not in the default test script. Add it:

Edit `package.json` test script:
```json
"test": "node --test tests/store.test.js tests/sse.test.js tests/api.test.js tests/proxy.test.js tests/sqlite.test.js"
```

Then:
```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.js tests/sqlite.test.js package.json
git commit -m "feat: add optional SQLite persistence"
```

---

## Task 9: Smoke Test End-to-End

- [ ] **Step 1: Start proxy with a mock upstream**

In terminal 1 — start a simple mock LLM:
```bash
node -e "
const http = require('http');
http.createServer((req,res) => {
  const b = [];
  req.on('data',c=>b.push(c));
  req.on('end',()=>{
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({
      choices:[{message:{role:'assistant',content:'Hello!'}}],
      usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}
    }));
  });
}).listen(8001, () => console.log('Mock LLM on :8001'));
"
```

In terminal 2 — start proxy:
```bash
npm start
```

- [ ] **Step 2: Send test requests**

```bash
# Non-streaming
curl -s -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[{"role":"user","content":"hello"}]}' | jq .

# Check history
curl -s http://localhost:8080/api/requests | jq '.[0] | {model,status,usage}'

# Check stats
curl -s http://localhost:8080/api/stats | jq .
```

Expected from stats:
```json
{
  "total": 1,
  "inputTokens": 5,
  "outputTokens": 3,
  "totalTokens": 8
}
```

- [ ] **Step 3: Verify web UI**

Open `http://localhost:8080`:
- Request appears in list with model `test-model`, status `complete`
- Click request → Request tab shows sent JSON
- Tokens tab shows `5 / 3 / 8`
- Raw tab shows full request+response, Copy button works
- Export JSON downloads file with 1 record
- Clear history wipes the list

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: end-to-end verified"
```
