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
