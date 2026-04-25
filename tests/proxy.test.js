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
