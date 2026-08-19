// Minimal Socket.IO client stand-in for the jsdom smoke test. The test file
// imports this same module (same resolved URL -> same instance) to drive
// fake server events into the client.
export const sockets = [];

export function io() {
  const socket = {
    handlers: new Map(),
    outbound: [],
    io: { on() {} },
    on(ev, fn) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, []);
      this.handlers.get(ev).push(fn);
    },
    emit(ev, payload) {
      this.outbound.push([ev, payload]);
    },
    trigger(ev, payload) {
      for (const fn of this.handlers.get(ev) ?? []) fn(payload);
    },
    disconnect() {},
  };
  sockets.push(socket);
  queueMicrotask(() => socket.trigger('connect'));
  return socket;
}
