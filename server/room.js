// Room lifecycle and the authoritative game loop. One Room = one lobby +
// one running simulation. All gameplay rules live in shared/sim.js; this file
// orchestrates sockets, seats, timing and scoring around it.
import crypto from 'node:crypto';
import {
  createGame,
  step,
  tryBuild,
  triggerPower,
  passTurn,
  snapshotAtoms,
  serializeBoard,
  turfScores,
  TICK_RATE,
  SNAP_EVERY,
} from '../shared/sim.js';

const VALID_MODES = new Set(['party', 'turf', 'duel']);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_PLAYERS = 8;
const MAX_PARTY_PLAYERS = 4;
const SEAT_GRACE_MS = 60_000;
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
const COUNTDOWN_MS = 3_000;
const INTERMISSION_MS = 4_000;
const TURF_ROUNDS_TO_WIN = 2; // best of 3

export const log = (obj) => console.log(JSON.stringify({ ts: Date.now(), ...obj }));

function sanitizeName(name) {
  const cleaned = String(name ?? '')
    .replace(/[^\p{L}\p{N} _\-'!.]/gu, '')
    .trim()
    .slice(0, 16);
  return cleaned || 'Player';
}

export class Room {
  constructor(io, code, mode, manager) {
    this.io = io;
    this.code = code;
    this.mode = VALID_MODES.has(mode) ? mode : 'party';
    this.manager = manager;
    this.players = new Map(); // token -> player record
    this.hostToken = null;
    this.phase = 'lobby'; // lobby | countdown | playing | intermission | end
    this.level = 1;
    this.sim = null;
    this.roundWins = new Map(); // turf: seat -> rounds won
    this.roundNo = 1;
    this.duelStarter = null; // last opener; null = coin flip next duel
    this.timer = null;
    this.loop = null;
    this.emptySince = Date.now();
    this.acc = 0;
    this.lastLoopAt = 0;
  }

  seatTaken(seat) {
    return [...this.players.values()].some((p) => p.seat === seat);
  }

  maxSeats() {
    return this.mode === 'party' ? MAX_PARTY_PLAYERS : MAX_PLAYERS;
  }

  join(socket, { name, hue, playerToken }) {
    // Rejoin by token within grace keeps the seat and, mid-game, the run.
    let p = playerToken && this.players.get(playerToken);
    if (p) {
      if (p.socket) p.socket.disconnect(true);
      p.socket = socket;
      p.name = sanitizeName(name ?? p.name);
      p.connected = true;
    } else {
      let seat = -1;
      for (let s = 0; s < this.maxSeats(); s++) {
        if (!this.seatTaken(s)) {
          seat = s;
          break;
        }
      }
      p = {
        token: crypto.randomBytes(16).toString('hex'),
        seat, // -1 = spectator
        name: sanitizeName(name),
        hue: Number.isFinite(+hue) ? Math.abs(+hue) % 360 : Math.floor(Math.random() * 360),
        socket,
        connected: true,
        ready: false,
        rate: { build: [], emote: [], general: [] },
      };
      // Spectators of an in-progress game keep seat -1 and get seated at
      // the next lobby/rematch (SDD §2.6).
      if (this.phase !== 'lobby' && p.seat !== -1 && this.sim && !this.sim.players.has(p.seat)) {
        p.pendingSeat = p.seat;
        p.seat = -1;
      }
      this.players.set(p.token, p);
      if (!this.hostToken) this.hostToken = p.token;
    }
    this.emptySince = null;
    socket.data.room = this;
    socket.data.token = p.token;
    socket.join(this.code);
    socket.emit('welcome', this.welcomePayload(p));
    this.broadcastLobby();
    log({ ev: 'join', room: this.code, seat: p.seat, name: p.name });
    return p;
  }

  welcomePayload(p) {
    return {
      playerToken: p.token,
      code: this.code,
      seat: p.seat,
      mode: this.mode,
      phase: this.phase,
      level: this.level,
      roundNo: this.roundNo,
      roundWins: Object.fromEntries(this.roundWins),
      players: this.lobbyPlayers(),
      host: this.isHost(p),
      board: this.sim ? serializeBoard(this.sim) : null,
    };
  }

  isHost(p) {
    return p.token === this.hostToken;
  }

  lobbyPlayers() {
    return [...this.players.values()]
      .filter((p) => p.connected || this.phase !== 'lobby')
      .map((p) => ({
        seat: p.seat,
        name: p.name,
        hue: p.hue,
        ready: p.ready,
        connected: p.connected,
        host: p.token === this.hostToken,
      }));
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobby', {
      players: this.lobbyPlayers(),
      mode: this.mode,
      level: this.level,
      phase: this.phase,
      roundNo: this.roundNo,
      roundWins: Object.fromEntries(this.roundWins),
    });
  }

  leave(socket, hard = false) {
    const token = socket.data.token;
    const p = token && this.players.get(token);
    if (!p) return;
    p.connected = false;
    p.ready = false;
    p.socket = null;
    log({ ev: 'leave', room: this.code, seat: p.seat, hard });
    const drop = () => {
      const cur = this.players.get(token);
      if (cur && !cur.connected) {
        this.players.delete(token);
        if (this.hostToken === token) {
          // Host migration: longest-seated connected player.
          const next = [...this.players.values()].find((x) => x.connected);
          this.hostToken = next ? next.token : null;
        }
        this.broadcastLobby();
      }
      if (![...this.players.values()].some((x) => x.connected)) {
        this.emptySince = this.emptySince ?? Date.now();
      }
    };
    if (hard) drop();
    else setTimeout(drop, SEAT_GRACE_MS).unref?.();
    if (![...this.players.values()].some((x) => x.connected)) {
      this.emptySince = Date.now();
    }
    this.broadcastLobby();
  }

  allow(p, kind, perSec) {
    const now = Date.now();
    const bucket = p.rate[kind];
    while (bucket.length && bucket[0] < now - 1000) bucket.shift();
    if (bucket.length >= perSec) return false;
    bucket.push(now);
    return true;
  }

  setReady(socket, ready) {
    const p = this.players.get(socket.data.token);
    if (!p || this.phase !== 'lobby') return;
    p.ready = !!ready;
    this.broadcastLobby();
    const seated = [...this.players.values()].filter((x) => x.connected && x.seat !== -1);
    if (seated.length && seated.every((x) => x.ready)) this.startCountdown();
  }

  hostAction(socket, action, payload = {}) {
    const p = this.players.get(socket.data.token);
    if (!p || !this.isHost(p)) return;
    if (action === 'start' && this.phase === 'lobby') this.startCountdown();
    if (action === 'mode' && this.phase === 'lobby') {
      this.mode = VALID_MODES.has(payload.mode) ? payload.mode : 'party';
      this.level = 1;
      this.broadcastLobby();
    }
    if (action === 'level' && this.phase === 'lobby' && this.mode === 'party') {
      this.level = Math.max(1, Math.min(30, Math.floor(+payload.level || 1)));
      this.broadcastLobby();
    }
    if (action === 'kick' && payload.seat !== undefined) {
      for (const [token, q] of this.players) {
        if (q.seat === +payload.seat && token !== this.hostToken) {
          if (q.socket) {
            q.socket.emit('kicked');
            q.socket.disconnect(true);
          }
          this.players.delete(token);
          this.broadcastLobby();
        }
      }
    }
    // From the podium ('end') or a between-levels intermission: return the
    // whole room to the lobby so the group can change mode without splitting.
    if (action === 'rematch' && (this.phase === 'end' || this.phase === 'intermission')) this.toLobby();
  }

  toLobby() {
    this.stopLoop();
    this.phase = 'lobby';
    this.sim = null;
    this.roundWins = new Map();
    this.roundNo = 1;
    // Seat pending spectators, clear ready flags.
    for (const p of this.players.values()) {
      p.ready = false;
      if (p.seat === -1) {
        for (let s = 0; s < this.maxSeats(); s++) {
          if (!this.seatTaken(s)) {
            p.seat = s;
            break;
          }
        }
      }
    }
    this.broadcastLobby();
  }

  startCountdown() {
    if (this.phase === 'countdown' || this.phase === 'playing') return;
    // Nobody left (everyone closed the tab mid-run): stop cycling rounds.
    if (![...this.players.values()].some((p) => p.connected)) {
      this.toLobby();
      return;
    }
    this.phase = 'countdown';
    const startAt = Date.now() + COUNTDOWN_MS;
    // Seat any pending spectators before the round starts.
    for (const p of this.players.values()) {
      if (p.seat === -1 && p.connected) {
        for (let s = 0; s < this.maxSeats(); s++) {
          if (!this.seatTaken(s)) {
            p.seat = s;
            break;
          }
        }
      }
    }
    const seats = [...this.players.values()]
      .filter((p) => p.connected && p.seat !== -1)
      .map((p) => ({ seat: p.seat }));
    const seed = crypto.randomInt(2 ** 31);
    // Duel opener: coin flip the first game, then alternate ("flip flop") on
    // every rematch. A starter who left the room forces a fresh flip.
    let firstTurn = null;
    if (this.mode === 'duel' && seats.length) {
      const seatIds = seats.map((s) => s.seat).sort((a, b) => a - b);
      let coinFlip = false;
      let starter;
      if (this.duelStarter === null || !seatIds.includes(this.duelStarter)) {
        starter = seatIds[crypto.randomInt(seatIds.length)];
        coinFlip = true;
      } else {
        starter = seatIds[(seatIds.indexOf(this.duelStarter) + 1) % seatIds.length];
      }
      this.duelStarter = starter;
      firstTurn = { seat: starter, coinFlip };
    }
    this.sim = createGame({ mode: this.mode, seed, seats, level: this.level, firstSeat: firstTurn?.seat });
    this.io.to(this.code).emit('start', {
      startAt,
      level: this.level,
      mode: this.mode,
      roundNo: this.roundNo,
      firstTurn,
      board: serializeBoard(this.sim),
      players: this.lobbyPlayers(),
    });
    this.broadcastLobby();
    this.timer = setTimeout(() => this.beginPlay(), COUNTDOWN_MS);
    this.timer.unref?.();
  }

  beginPlay() {
    this.phase = 'playing';
    this.lastLoopAt = Date.now();
    this.acc = 0;
    this.loop = setInterval(() => this.tickLoop(), 1000 / TICK_RATE / 2);
    this.loop.unref?.();
    log({ ev: 'roundStart', room: this.code, mode: this.mode, level: this.level, round: this.roundNo });
  }

  stopLoop() {
    if (this.loop) clearInterval(this.loop);
    if (this.timer) clearTimeout(this.timer);
    this.loop = null;
    this.timer = null;
  }

  tickLoop() {
    const now = Date.now();
    this.acc += (now - this.lastLoopAt) / 1000;
    this.lastLoopAt = now;
    const dt = 1 / TICK_RATE;
    let guard = 0;
    while (this.acc >= dt && guard++ < 10) {
      this.acc -= dt;
      const events = step(this.sim);
      this.dispatch(events);
      if (this.sim.tick % SNAP_EVERY === 0) {
        this.io.to(this.code).emit('snap', {
          t: this.sim.tick,
          atoms: snapshotAtoms(this.sim),
          pct: this.sim.filled / (48 * 30),
          timer: this.sim.timer,
          turn: this.sim.turn ? { seat: this.sim.turn.seat, left: this.sim.turn.ticksLeft } : undefined,
          energy:
            this.mode === 'turf'
              ? Object.fromEntries(
                  [...this.sim.players.values()].map((p) => [p.seat, Math.round(p.energy)])
                )
              : undefined,
        });
      }
      if (this.sim.over) break;
    }
  }

  dispatch(events) {
    for (const e of events) {
      if (e.type === 'end') {
        this.onRoundEnd(e);
        continue;
      }
      if (e.type === 'turn') {
        // Never hand the turn to an empty chair: chain past disconnected
        // seats (bounded — a fully empty room pauses via emptySince anyway).
        let ev = e;
        let guard = 0;
        while (guard++ < 16) {
          const holder = [...this.players.values()].find((p) => p.seat === ev.seat);
          if (holder && holder.connected) break;
          const next = passTurn(this.sim).find((x) => x.type === 'turn');
          if (!next) break;
          ev = { ...next, skipped: true };
        }
        this.io.to(this.code).emit('turn', ev);
        continue;
      }
      // set / shatter / capture / stun / split / lives / power / powerSpawn / hurry
      this.io.to(this.code).emit(e.type, e);
    }
  }

  onRoundEnd(e) {
    this.stopLoop();
    const summary = {
      result: e.result,
      level: this.level,
      pct: this.sim.filled / (48 * 30),
      turf: this.mode !== 'party' ? turfScores(this.sim) : undefined,
      roundNo: this.roundNo,
    };
    log({ ev: 'roundEnd', room: this.code, ...summary });
    if (this.mode === 'party') {
      if (e.result === 'victory') {
        this.level += 1;
        this.phase = 'intermission';
        this.io.to(this.code).emit('end', { ...summary, next: 'level' });
        this.timer = setTimeout(() => this.startCountdown(), INTERMISSION_MS);
      this.timer.unref?.();
      } else {
        this.phase = 'end';
        this.io.to(this.code).emit('end', { ...summary, next: 'lobby' });
      }
      return;
    }
    if (this.mode === 'duel') {
      // Single board, no series: most turf when the arena fills wins.
      const scores = summary.turf ?? {};
      let champion = null;
      let best = -1;
      for (const [seat, n] of Object.entries(scores)) {
        if (n > best) {
          best = n;
          champion = +seat;
        }
      }
      this.phase = 'end';
      this.io.to(this.code).emit('end', { ...summary, next: 'lobby', champion });
      return;
    }
    // Turf: tally the round, run best-of-3.
    const scores = summary.turf ?? {};
    let bestSeat = null;
    let best = -1;
    for (const [seat, n] of Object.entries(scores)) {
      if (n > best) {
        best = n;
        bestSeat = +seat;
      }
    }
    if (bestSeat !== null) {
      this.roundWins.set(bestSeat, (this.roundWins.get(bestSeat) ?? 0) + 1);
    }
    const champion = [...this.roundWins.entries()].find(([, w]) => w >= TURF_ROUNDS_TO_WIN);
    if (champion) {
      this.phase = 'end';
      this.io.to(this.code).emit('end', {
        ...summary,
        next: 'lobby',
        roundWins: Object.fromEntries(this.roundWins),
        champion: champion[0],
      });
    } else {
      this.roundNo += 1;
      this.phase = 'intermission';
      this.io.to(this.code).emit('end', {
        ...summary,
        next: 'round',
        roundWins: Object.fromEntries(this.roundWins),
      });
      this.timer = setTimeout(() => this.startCountdown(), INTERMISSION_MS);
      this.timer.unref?.();
    }
  }

  build(socket, { seq, cx, cy, axis }) {
    const p = this.players.get(socket.data.token);
    if (!p || p.seat === -1 || this.phase !== 'playing' || !this.sim) {
      socket.emit('wall', { seq, ok: false, reason: 'phase' });
      return;
    }
    if (!this.allow(p, 'build', 4)) {
      socket.emit('wall', { seq, ok: false, reason: 'rate' });
      return;
    }
    const r = tryBuild(this.sim, p.seat, Math.floor(+cx), Math.floor(+cy), axis);
    if (!r.ok) {
      socket.emit('wall', { seq, ok: false, reason: r.reason });
      return;
    }
    this.io.to(this.code).emit('wall', {
      seq,
      ok: true,
      id: r.wall.id,
      cx: r.wall.cx,
      cy: r.wall.cy,
      axis: r.wall.axis,
      startTick: r.wall.startTick,
      ghost: r.wall.ghost,
      quickset: r.wall.quickset,
      who: p.seat,
    });
  }

  power(socket, { slot }) {
    const p = this.players.get(socket.data.token);
    if (!p || p.seat === -1 || this.phase !== 'playing' || !this.sim) return;
    if (!this.allow(p, 'general', 5)) return;
    const r = triggerPower(this.sim, p.seat, Math.floor(+slot));
    if (r.ok) this.io.to(this.code).emit('powerUsed', { kind: r.kind, powers: r.powers, who: p.seat });
  }

  emote(socket, { id }) {
    const p = this.players.get(socket.data.token);
    if (!p) return;
    if (!this.allow(p, 'emote', 1)) return;
    const eid = Math.abs(Math.floor(+id || 0)) % 8;
    this.io.to(this.code).emit('emote', { seat: p.seat, name: p.name, id: eid });
  }

  destroy() {
    this.stopLoop();
    for (const p of this.players.values()) {
      if (p.socket) p.socket.disconnect(true);
    }
    log({ ev: 'roomDestroyed', room: this.code });
  }
}

export class RoomManager {
  constructor(io, { maxRooms = 500 } = {}) {
    this.io = io;
    this.rooms = new Map();
    this.maxRooms = maxRooms;
    this.gc = setInterval(() => this.sweep(), 60_000);
    this.gc.unref?.();
  }

  makeCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  create(mode) {
    if (this.rooms.size >= this.maxRooms) return null;
    const room = new Room(this.io, this.makeCode(), mode, this);
    this.rooms.set(room.code, room);
    log({ ev: 'roomCreated', room: room.code, mode: room.mode });
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').toUpperCase().trim());
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        room.destroy();
        this.rooms.delete(code);
      }
    }
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) {
      players += [...r.players.values()].filter((p) => p.connected).length;
    }
    return { rooms: this.rooms.size, players };
  }
}
