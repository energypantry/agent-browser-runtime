export class ExtensionRpc {
  constructor(logger = console) {
    this.logger = logger;
    this.sockets = new Set();
    this.pending = new Map();
    this.waiters = new Set();
    this.nextId = 1;
  }

  get connected() {
    return Boolean(this.#activeSocket());
  }

  attach(socket) {
    this.sockets.add(socket);
    socket.on('message', (raw) => this.#handleMessage(raw));
    socket.on('close', () => this.#detach(socket));
    socket.on('error', () => this.#detach(socket));
    this.#notifyWaiters();
  }

  #detach(socket) {
    this.sockets.delete(socket);
    for (const [id, pending] of this.pending.entries()) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(Object.assign(new Error(`Extension RPC disconnected: ${pending.method}`), { code: 'EXTENSION_DISCONNECTED' }));
    }
  }

  async call(method, params = {}, { timeoutMs = 30000, connectTimeoutMs = Math.min(timeoutMs, 10000) } = {}) {
    const socket = await this.#waitForConnection(connectTimeoutMs);

    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Extension RPC timeout: ${method}`), { code: 'EXTENSION_RPC_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method, socket });
      socket.send(JSON.stringify(payload));
    });
  }

  #activeSocket() {
    return Array.from(this.sockets).find((socket) => socket.readyState === 1) || null;
  }

  #waitForConnection(timeoutMs) {
    const socket = this.#activeSocket();
    if (socket) return Promise.resolve(socket);

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(Object.assign(new Error('Chrome companion extension is not connected'), { code: 'EXTENSION_DISCONNECTED' }));
        }, Math.max(1, Number(timeoutMs) || 1)),
      };
      this.waiters.add(waiter);
    });
  }

  #notifyWaiters() {
    const socket = this.#activeSocket();
    if (!socket) return;
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(socket);
    }
  }

  #handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      this.logger.warn?.({ error }, 'invalid extension message');
      return;
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'Extension RPC error'), { code: msg.error.code || 'EXTENSION_RPC_ERROR' }));
      else pending.resolve(msg.result);
      return;
    }

    this.logger.info?.({ extensionEvent: msg }, 'extension event');
  }
}
