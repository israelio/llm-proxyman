const { randomUUID } = require('node:crypto');

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '1000', 10);

let records = [];
let db = null;

function tryParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

function initDb() {
  if (process.env.PERSIST === 'false') return;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(process.env.DB_PATH || './proxy-history.db');
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        method TEXT,
        path TEXT,
        model TEXT,
        upstream TEXT,
        status TEXT,
        duration_ms INTEGER,
        request_json TEXT,
        response_json TEXT,
        chunks_json TEXT,
        usage_json TEXT,
        error TEXT
      )
    `);
    // migration: add upstream column to existing databases
    try { db.exec('ALTER TABLE requests ADD COLUMN upstream TEXT'); } catch {}
    const rows = db.prepare(
      'SELECT * FROM requests ORDER BY timestamp DESC LIMIT ?'
    ).all(MAX_HISTORY);
    records = rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      method: row.method,
      path: row.path,
      model: row.model,
      upstream: row.upstream,
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

function persistRecord(r) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO requests
        (id, timestamp, method, path, model, upstream, status, duration_ms,
         request_json, response_json, chunks_json, usage_json, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      r.id, r.timestamp, r.method, r.path, r.model, r.upstream ?? null, r.status, r.durationMs,
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
    upstream: data.upstream,
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
