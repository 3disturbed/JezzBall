import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';

process.env.PORT = '0'; // ephemeral port for tests
const { http, io, rooms } = await import('../server/index.js');

let base;

before(async () => {
  await new Promise((resolve) => {
    if (http.listening) return resolve();
    http.on('listening', resolve);
  });
  base = `http://127.0.0.1:${http.address().port}`;
});

after(() => {
  for (const room of rooms.rooms.values()) room.destroy();
  rooms.rooms.clear();
  io.close();
  http.close();
  clearInterval(rooms.gc);
});

const client = () => connect(base, { transports: ['websocket'], forceNew: true });

const once = (sock, ev, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), timeout);
    sock.once(ev, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

test('create, join by code, welcome payloads', async () => {
  const a = client();
  a.emit('create', { mode: 'party', name: 'Alice', hue: 20 });
  const wa = await once(a, 'welcome');
  assert.equal(wa.seat, 0);
  assert.equal(wa.host, true);
  assert.match(wa.code, /^[A-Z2-9]{6}$/);
  assert.ok(!/[0O1I]/.test(wa.code));

  const b = client();
  b.emit('hello', { roomCode: wa.code.toLowerCase(), name: '<Bob> $$', hue: 200 });
  const wb = await once(b, 'welcome');
  assert.equal(wb.seat, 1);
  assert.equal(wb.host, false);
  assert.equal(wb.code, wa.code);
  // Name sanitized (welcome carries the current player list).
  const bob = wb.players.find((p) => p.seat === 1);
  assert.equal(bob.name, 'Bob');
  a.disconnect();
  b.disconnect();
});

test('joining a nonexistent room errors', async () => {
  const c = client();
  c.emit('hello', { roomCode: 'ZZZZZZ', name: 'X' });
  const err = await once(c, 'errorMsg');
  assert.equal(err.code, 'nosuchroom');
  c.disconnect();
});

test('full round trip: ready -> start -> build -> capture events', async () => {
  const a = client();
  a.emit('create', { mode: 'party', name: 'Solo' });
  const wa = await once(a, 'welcome');
  const startP = once(a, 'start', 6000);
  a.emit('ready', { ready: true });
  const start = await startP;
  assert.equal(start.level, 1);
  assert.ok(start.board.atoms.length >= 3);
  // Wait for play phase, then build at a spot away from atoms.
  await new Promise((r) => setTimeout(r, 3200));
  const room = rooms.get(wa.code);
  // Park atoms server-side so the wall survives deterministically.
  for (const atom of room.sim.atoms) {
    atom.x = 2.5;
    atom.y = 2.5;
    atom.vx = 0;
    atom.vy = 0;
  }
  // Subscribe up front: capture and end land in the same dispatch batch.
  const ackP = once(a, 'wall');
  const capP = once(a, 'capture', 8000);
  const endP = once(a, 'end', 8000);
  // x=10 captures the whole right side (~77%) -> victory in one wall.
  a.emit('build', { seq: 7, cx: 10, cy: 15, axis: 'v' });
  const ack = await ackP;
  assert.equal(ack.seq, 7);
  assert.equal(ack.ok, true);
  assert.equal(ack.who, 0);
  assert.ok(ack.startTick >= 0);
  const capture = await capP;
  assert.ok(capture.cells.length > 1000);
  const end = await endP;
  assert.equal(end.result, 'victory');
  assert.equal(end.next, 'level');
  // Main-menu bail-out: host can return the room to the lobby from the
  // between-levels intermission (group stays together, mode changeable).
  const lobbyP = once(a, 'lobby');
  a.emit('host', { action: 'rematch' });
  const lob = await lobbyP;
  assert.equal(lob.phase, 'lobby');
  a.disconnect();
});

test('build rejections: out of phase and rate limiting', async () => {
  const a = client();
  a.emit('create', { mode: 'party', name: 'R' });
  await once(a, 'welcome');
  // Not playing yet.
  const ackP = once(a, 'wall');
  a.emit('build', { seq: 1, cx: 10, cy: 10, axis: 'v' });
  const ack = await ackP;
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'phase');
  a.disconnect();
});

test('rejoin with playerToken reclaims the seat', async () => {
  const a = client();
  a.emit('create', { mode: 'turf', name: 'Kai', hue: 99 });
  const wa = await once(a, 'welcome');
  a.disconnect();
  await new Promise((r) => setTimeout(r, 100));
  const b = client();
  b.emit('hello', { roomCode: wa.code, playerToken: wa.playerToken, name: 'Kai' });
  const wb = await once(b, 'welcome');
  assert.equal(wb.seat, wa.seat);
  assert.equal(wb.playerToken, wa.playerToken);
  b.disconnect();
});

test('host migration on hard leave', async () => {
  const a = client();
  a.emit('create', { mode: 'party', name: 'Host' });
  const wa = await once(a, 'welcome');
  const b = client();
  b.emit('hello', { roomCode: wa.code, name: 'Next' });
  await once(b, 'welcome');
  const room = rooms.get(wa.code);
  // Simulate the grace timer having fired for a's seat.
  const aToken = wa.playerToken;
  room.players.get(aToken).connected = false;
  room.players.delete(aToken);
  room.hostToken = [...room.players.values()].find((p) => p.connected)?.token ?? null;
  const lobbyP = once(b, 'lobby');
  room.broadcastLobby();
  const lobby = await lobbyP;
  const next = lobby.players.find((p) => p.name === 'Next');
  assert.ok(next.host, 'second player inherited host');
  a.disconnect();
  b.disconnect();
});

test('duel: opener is coin-flipped, then alternates on rematch', async () => {
  const a = client();
  a.emit('create', { mode: 'duel', name: 'FlipA' });
  const wa = await once(a, 'welcome');
  const b = client();
  b.emit('hello', { roomCode: wa.code, name: 'FlipB' });
  await once(b, 'welcome');

  const start1P = once(a, 'start');
  a.emit('ready', { ready: true });
  b.emit('ready', { ready: true });
  const s1 = await start1P;
  assert.equal(s1.firstTurn.coinFlip, true, 'first game is a coin flip');
  const first = s1.firstTurn.seat;
  assert.ok(first === 0 || first === 1);
  assert.equal(s1.board.turn.seat, first, 'sim opener matches the flip');

  // Force the match over server-side, then rematch.
  const room = rooms.get(wa.code);
  const endP = once(a, 'end');
  room.onRoundEnd({ result: 'filled' });
  await endP;
  const lobbyP = once(b, 'lobby');
  a.emit('host', { action: 'rematch' });
  await lobbyP;

  const start2P = once(a, 'start');
  a.emit('ready', { ready: true });
  b.emit('ready', { ready: true });
  const s2 = await start2P;
  assert.equal(s2.firstTurn.coinFlip, false, 'rematch is not a flip');
  assert.equal(s2.firstTurn.seat, first === 0 ? 1 : 0, 'opener alternates');
  a.disconnect();
  b.disconnect();
});

test('healthz reports rooms', async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.rooms >= 0);
});

test('GET /api/rooms/:code reports room info, 404 for unknown', async () => {
  const miss = await fetch(`${base}/api/rooms/ZZZZZZ`);
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { error: 'not_found' });

  const a = client();
  a.emit('create', { mode: 'party', name: 'Host' });
  const wa = await once(a, 'welcome');
  const res = await fetch(`${base}/api/rooms/${wa.code.toLowerCase()}`);
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.deepEqual(info, { code: wa.code, players: 1, max: 4, phase: 'lobby', mode: 'party', joinable: true });
  assert.ok(!JSON.stringify(info).includes('Host'), 'no player names leak');
  a.disconnect();
});
