// JezzBall server — Express static + Socket.IO + room manager.
// nginx serves public/ directly in production and proxies /socket.io/,
// /shared/ and /r/<code> here (see docs/SDD.md §3.2, §3.7).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { RoomManager, log } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const started = Date.now();

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round((Date.now() - started) / 1000), ...rooms.stats() });
});

// Room info for the Darks Games social layer (catalog roomInfoUrl) and deep
// links: unauthenticated, no player names. Registered before the static
// middleware so it can never be shadowed by a file.
app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'not_found' });
  const players = [...room.players.values()].filter((p) => p.connected).length;
  res.json({ code: room.code, players, max: room.maxSeats(), phase: room.phase, mode: room.mode, joinable: players < room.maxSeats() });
});

// The client imports the sim for wall prediction.
app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: '1h' }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h', index: 'index.html' }));

// Deep links: /r/ABC123 serves the app shell; the client reads the code.
app.get('/r/:code', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

const http = createServer(app);
const io = new Server(http, {
  serveClient: true,
  maxHttpBufferSize: 4096,
  cors: { origin: false },
});
const rooms = new RoomManager(io);

io.on('connection', (socket) => {
  socket.on('create', (payload = {}) => {
    if (socket.data.room) return;
    const room = rooms.create(payload.mode);
    if (!room) {
      socket.emit('errorMsg', { code: 'full', message: 'Server is full — try again soon.' });
      return;
    }
    room.join(socket, payload);
  });

  socket.on('hello', (payload = {}) => {
    if (socket.data.room) return;
    const room = rooms.get(payload.roomCode);
    if (!room) {
      socket.emit('errorMsg', { code: 'nosuchroom', message: 'That room no longer exists.' });
      return;
    }
    room.join(socket, payload);
  });

  const inRoom = (fn) => (payload) => {
    const room = socket.data.room;
    if (room) fn(room, payload ?? {});
  };
  socket.on('ready', inRoom((room, p) => room.setReady(socket, p.ready)));
  socket.on('build', inRoom((room, p) => room.build(socket, p)));
  socket.on('power', inRoom((room, p) => room.power(socket, p)));
  socket.on('emote', inRoom((room, p) => room.emote(socket, p)));
  socket.on('host', inRoom((room, p) => room.hostAction(socket, p.action, p)));
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) room.leave(socket);
  });
});

// Malformed frames should never take the process down.
io.engine.on('connection_error', (err) => {
  log({ ev: 'connError', code: err.code, message: err.message });
});
process.on('uncaughtException', (err) => {
  log({ ev: 'uncaught', error: String(err && err.stack) });
});

setInterval(() => log({ ev: 'stats', ...rooms.stats() }), 5 * 60_000).unref();

http.listen(PORT, () => log({ ev: 'listen', port: PORT }));

export { app, http, io, rooms };
