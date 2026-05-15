import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtensionRpc } from '../src/extension-rpc.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    setImmediate(() => {
      this.emit('message', JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { ok: true, method: message.method },
      }));
    });
  }
}

const silentLogger = { info() {}, warn() {} };

test('call waits briefly for the extension socket to reconnect', async () => {
  const rpc = new ExtensionRpc(silentLogger);
  const call = rpc.call('ping', {}, { timeoutMs: 1000, connectTimeoutMs: 250 });

  const socket = new FakeSocket();
  setTimeout(() => rpc.attach(socket), 25);

  const result = await call;
  assert.deepEqual(result, { ok: true, method: 'ping' });
  assert.equal(socket.sent.length, 1);
});

test('connected ignores sockets that are no longer open', () => {
  const rpc = new ExtensionRpc(silentLogger);
  const socket = new FakeSocket();

  rpc.attach(socket);
  assert.equal(rpc.connected, true);

  socket.readyState = 3;
  assert.equal(rpc.connected, false);
});
