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
