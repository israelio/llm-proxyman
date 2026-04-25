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
