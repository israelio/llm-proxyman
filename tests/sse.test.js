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
