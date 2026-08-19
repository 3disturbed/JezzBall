// Client smoke test: boot the real browser modules in jsdom, join a fake
// room, and render one frame. Exits non-zero on any throw.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
register('./smoke-loader.mjs', import.meta.url);

// ---------- browser environment ----------
const html = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });
const { window } = dom;

// A universal no-op canvas context: every method exists, returns itself.
const ctxStub = new Proxy(function () {}, {
  get: (_t, prop) => {
    if (prop === Symbol.toPrimitive) return () => 0;
    return ctxStub;
  },
  set: () => true,
  apply: () => ctxStub,
});
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;

let rafCallback = null;
const globals = {
  window,
  document: window.document,
  localStorage: window.localStorage,
  location: window.location,
  history: window.history,
  matchMedia: () => ({ matches: false }),
  requestAnimationFrame: (cb) => {
    rafCallback = cb;
    return 1;
  },
  cancelAnimationFrame: () => {},
  devicePixelRatio: 1,
  AudioContext: class {
    currentTime = 0;
    sampleRate = 8000;
    state = 'running';
    resume() {}
    #node() {
      const param = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
      return {
        type: '',
        gain: param,
        frequency: param,
        buffer: null,
        connect: (n) => n ?? {},
        start() {},
        stop() {},
      };
    }
    createGain() {
      return this.#node();
    }
    createOscillator() {
      return this.#node();
    }
    createBufferSource() {
      return this.#node();
    }
    createBiquadFilter() {
      return this.#node();
    }
    createBuffer(_ch, len) {
      return { getChannelData: () => new Float32Array(len) };
    }
    get destination() {
      return this.#node();
    }
  },
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

// ---------- boot the client ----------
window.localStorage.setItem('jb-name', 'Smoke');
const { game } = await import('../../public/js/main.js');
const { sockets } = await import('./socketio-stub.mjs');
const sim = await import('../../shared/sim.js');

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  }
};

assert(window.document.querySelector('#arena'), 'canvas mounts');
assert(window.document.querySelector('#screen-landing.active'), 'landing screen shows');
assert(window.document.querySelector('#btn-solo'), 'solo button present');
assert(window.document.querySelector('#solo-level'), 'solo level picker present');

// Create a room via the real button path.
window.document.querySelector('#btn-create').click();
await new Promise((r) => setTimeout(r, 10));
assert(sockets.length === 1, 'socket created');
const socket = sockets[0];
assert(socket.outbound.some(([ev]) => ev === 'create'), 'create emitted');

// Fake server: welcome into a playing room with a real board.
const state = sim.createGame({ mode: 'party', seed: 42, seats: [{ seat: 0 }], level: 1 });
for (let i = 0; i < 30; i++) sim.step(state);
socket.trigger('welcome', {
  playerToken: 'tok',
  code: 'ABCDEF',
  seat: 0,
  mode: 'party',
  phase: 'playing',
  level: 1,
  roundNo: 1,
  roundWins: {},
  host: true,
  players: [{ seat: 0, name: 'Smoke', hue: 20, ready: false, connected: true, host: true }],
  board: sim.serializeBoard(state),
});

assert(window.document.querySelector('#screen-game.active'), 'game screen shows after welcome');
assert(game.atoms.size === state.atoms.length, 'atoms loaded from board');

// A snapshot arrives, then one frame renders without throwing.
for (let i = 0; i < 4; i++) sim.step(state);
socket.trigger('snap', {
  t: state.tick,
  atoms: sim.snapshotAtoms(state),
  pct: state.filled / (48 * 30),
});
socket.trigger('set', { wall: 1, head: 0, cells: [100, 148], who: 0 });
socket.trigger('capture', { cells: [200, 201, 202], who: 0, pct: 0.01, combo: 1 });
assert(typeof rafCallback === 'function', 'render loop started');
rafCallback();
rafCallback();

console.log('smoke ok: client boots, joins, renders');
process.exit(0);
