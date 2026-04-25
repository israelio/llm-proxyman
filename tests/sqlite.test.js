const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'test-persist.db');

describe('sqlite persistence', () => {
  before(() => {
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
