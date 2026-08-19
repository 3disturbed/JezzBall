// JezzBall client — net, screens, HUD. Rendering lives in render.js,
// input in input.js, sound in sfx.js.
import { io } from '/socket.io/socket.io.esm.min.js';
import { W, H, TOTAL, CELL, TICK_RATE } from '/shared/sim.js?v=4';
import { Renderer } from '/js/render.js?v=4';
import { attachInput } from '/js/input.js?v=4';
import { sfx } from '/js/sfx.js?v=4';

const $ = (sel) => document.querySelector(sel);
const screens = {
  landing: $('#screen-landing'),
  lobby: $('#screen-lobby'),
  game: $('#screen-game'),
  end: $('#screen-end'),
};
const EMOJI = ['😀', '😱', '🔥', '💀', '👏', '❤️', '🤝', '🫠'];
const POWER_ICON = { freeze: '🧊', quickset: '⚡', ghost: '👻' };

export const game = {
  // net + identity
  socket: null,
  token: localStorage.getItem('jb-token') || null,
  code: null,
  seat: -1,
  isHost: false,
  mode: 'party',
  phase: 'lobby',
  players: [],
  level: 1,
  roundNo: 1,
  roundWins: {},
  // board state (authoritative mirrors + prediction)
  grid: new Uint8Array(TOTAL),
  owner: new Uint8Array(TOTAL),
  walls: new Map(), // id -> {id, cx, cy, axis, startTick, who, quickset, ghost, heads:{0:{cells,done},1:{...}}}
  pendingWalls: new Map(), // seq -> predicted wall
  atoms: new Map(), // id -> {type, snaps:[{t,x,y,vx,vy}]}
  powerups: [],
  powers: [],
  pct: 0,
  lives: 0,
  energy: {},
  timer: 0,
  turn: null, // duel: {seat, left}
  latestTick: 0,
  tickOffsetMs: null, // EMA of (recvAt - t*tickMs)
  seq: 1,
  axis: 'v',
  aim: null, // {cx, cy} hover cell
  over: false,
  solo: false,
};

// Solo progression: furthest level reached, remembered on-device.
const bestLevel = () => Math.max(1, Math.min(30, +localStorage.getItem('jb-best') || 1));
function recordLevelReached(level) {
  if (level > bestLevel()) localStorage.setItem('jb-best', String(Math.min(30, level)));
}
function refreshSoloPicker() {
  const wrap = $('#solo-level-wrap');
  const sel = $('#solo-level');
  const best = bestLevel();
  wrap.hidden = best <= 1;
  sel.innerHTML = '';
  for (let l = 1; l <= best; l++) {
    const o = document.createElement('option');
    o.value = String(l);
    o.textContent = String(l);
    sel.append(o);
  }
  sel.value = String(best);
}
export const tickMs = 1000 / TICK_RATE;

// Estimated current server tick (drives wall growth + interpolation clock).
export function serverTickNow() {
  if (game.tickOffsetMs === null) return game.latestTick;
  return (performance.now() - game.tickOffsetMs) / tickMs;
}

function show(name) {
  for (const s of Object.values(screens)) s.classList.remove('active');
  screens[name].classList.add('active');
}

// ---------- identity ----------
const nameInput = $('#name-input');
const hueInput = $('#hue-input');
nameInput.value = localStorage.getItem('jb-name') || '';
hueInput.value = localStorage.getItem('jb-hue') || String(Math.floor(Math.random() * 360));
const hueChip = $('#hue-chip');
const paintChip = () => (hueChip.style.background = `hsl(${hueInput.value} 80% 60%)`);
hueInput.addEventListener('input', paintChip);
paintChip();

export const seatColor = (seat) => {
  const p = game.players.find((x) => x.seat === seat);
  return `hsl(${p ? p.hue : 0} 80% 60%)`;
};
export const seatName = (seat) => {
  const p = game.players.find((x) => x.seat === seat);
  return p ? p.name : '?';
};

// ---------- socket ----------
function connect(after) {
  if (game.socket) return after();
  const socket = io({ transports: ['websocket', 'polling'] });
  game.socket = socket;

  socket.on('welcome', (w) => {
    game.token = w.playerToken;
    localStorage.setItem('jb-token', w.playerToken);
    localStorage.setItem('jb-room', w.code);
    game.code = w.code;
    game.seat = w.seat;
    game.isHost = w.host;
    game.mode = w.mode;
    game.phase = w.phase;
    game.level = w.level;
    game.roundNo = w.roundNo;
    game.roundWins = w.roundWins || {};
    game.players = w.players;
    history.replaceState(null, '', `/r/${w.code}`);
    if (w.board) {
      // Rejoin mid-run; a one-seat room keeps solo ergonomics.
      game.solo = w.players.length === 1;
      loadBoard(w.board);
      startRound(false);
    } else if (game.solo) {
      // Solo quick-start: skip the lobby, jump straight into the ladder.
      game.socket.emit('host', { action: 'level', level: +($('#solo-level').value || 1) });
      game.socket.emit('host', { action: 'start' });
      show('game');
    } else {
      renderLobby();
      show('lobby');
    }
  });

  socket.on('lobby', (l) => {
    game.players = l.players;
    game.mode = l.mode;
    game.level = l.level;
    game.phase = l.phase;
    game.roundNo = l.roundNo;
    game.roundWins = l.roundWins || {};
    game.isHost = !!l.players.find((p) => p.seat === game.seat && p.host);
    // A friend joining a solo run converts it to a normal multiplayer room.
    if (game.solo && l.players.filter((p) => p.connected).length > 1) game.solo = false;
    if (!game.solo && l.phase === 'lobby' && !screens.lobby.classList.contains('active')) show('lobby');
    renderLobby();
  });

  socket.on('start', (s) => {
    if (s.mode === 'party') recordLevelReached(s.level);
    game.mode = s.mode;
    game.level = s.level;
    game.roundNo = s.roundNo;
    game.players = s.players;
    loadBoard(s.board);
    startRound(true, s.startAt);
  });

  socket.on('snap', (s) => {
    game.latestTick = s.t;
    const now = performance.now();
    const off = now - s.t * tickMs;
    game.tickOffsetMs = game.tickOffsetMs === null ? off : game.tickOffsetMs * 0.9 + off * 0.1;
    game.pct = s.pct;
    if (s.timer !== undefined) game.timer = s.timer;
    if (s.turn) game.turn = s.turn;
    if (s.energy) game.energy = s.energy;
    const seen = new Set();
    for (const [id, x, y, vx, vy, type] of s.atoms) {
      seen.add(id);
      let a = game.atoms.get(id);
      if (!a) {
        a = { type, snaps: [] };
        game.atoms.set(id, a);
      }
      a.type = type;
      a.snaps.push({ t: s.t, x, y, vx, vy });
      if (a.snaps.length > 6) a.snaps.shift();
    }
    for (const id of [...game.atoms.keys()]) if (!seen.has(id)) game.atoms.delete(id);
    updateHud();
  });

  socket.on('wall', (w) => {
    if (w.ok) {
      const wall = {
        id: w.id,
        cx: w.cx,
        cy: w.cy,
        axis: w.axis,
        startTick: w.startTick,
        who: w.who,
        ghost: w.ghost,
        quickset: w.quickset,
        heads: { 0: { cells: null, done: false }, 1: { cells: null, done: false } },
      };
      game.walls.set(w.id, wall);
      if (w.seq && game.pendingWalls.has(w.seq)) {
        game.pendingWalls.delete(w.seq); // prediction reconciled
      }
      if (w.who === game.seat) sfx.thunk();
    } else if (w.seq && game.pendingWalls.has(w.seq)) {
      game.pendingWalls.delete(w.seq);
      renderer.fizzle(w.cx, w.cy);
      if (w.reason === 'energy') banner('Not enough energy!');
    }
  });

  socket.on('set', (e) => {
    const wall = game.walls.get(e.wall);
    if (wall) {
      wall.heads[e.head].cells = e.cells;
      wall.heads[e.head].done = true;
    }
    for (const ci of e.cells) {
      game.grid[ci] = CELL.SOLID;
      game.owner[ci] = e.who + 1;
    }
    sfx.clunk();
  });

  socket.on('shatter', (e) => {
    const wall = game.walls.get(e.wall);
    if (wall) {
      wall.heads[e.head].cells = [];
      wall.heads[e.head].done = true;
      if (wall.heads[0].done && wall.heads[1].done) game.walls.delete(e.wall);
    }
    for (const ci of e.cells) game.grid[ci] = CELL.EMPTY;
    renderer.shatter(e.cells);
    sfx.shatter();
  });

  socket.on('stun', () => sfx.stun());

  socket.on('capture', (e) => {
    for (const ci of e.cells) {
      game.grid[ci] = CELL.FILLED;
      game.owner[ci] = e.who + 1;
    }
    game.pct = e.pct;
    // Wall bookkeeping: completed walls leave the map once both heads set.
    for (const [id, wall] of game.walls) {
      if (wall.heads[0].done && wall.heads[1].done) game.walls.delete(id);
    }
    renderer.capture(e.cells, e.who, e.combo);
    sfx.capture(e.combo);
    if (e.combo >= 2) banner(`COMBO ×${e.combo} — ${seatName(e.who)}!`);
    if (game.mode === 'party' && e.pct >= 0.6 && e.pct < 0.75) banner(`${Math.round(e.pct * 100)}%!`);
    updateHud();
  });

  socket.on('split', (e) => {
    renderer.burst(e.at.x, e.at.y, '#ff5dcb');
    banner('SPLITTER!');
    sfx.split();
  });

  socket.on('lives', (e) => {
    game.lives = e.lives;
    updateHud();
  });

  socket.on('powerSpawn', (e) => {
    game.powerups.push(e.pu);
  });

  socket.on('power', (e) => {
    game.powers = e.powers;
    game.powerups = game.powerups.filter((p) => game.grid[p.cy * W + p.cx] !== CELL.FILLED);
    banner(`${POWER_ICON[e.kind]} ${e.kind.toUpperCase()} ready!`);
    updateHud();
  });

  socket.on('powerUsed', (e) => {
    game.powers = e.powers;
    banner(`${POWER_ICON[e.kind]} ${e.kind.toUpperCase()} — ${seatName(e.who)}`);
    sfx.power();
    updateHud();
  });

  socket.on('hurry', () => {
    banner('30 SECONDS — HURRY!');
    sfx.hurry();
  });

  socket.on('turn', (e) => {
    game.turn = { seat: e.seat, left: 30 * TICK_RATE };
    if (e.seat === game.seat) {
      banner('YOUR TURN');
      sfx.go();
    } else if (e.passed && e.prev === game.seat) {
      banner(`Out of time — ${seatName(e.seat)}'s turn`);
      sfx.stun();
    } else {
      banner(`${seatName(e.seat)}'s turn`);
    }
    updateHud();
  });

  socket.on('emote', (e) => {
    renderer.emote(e.seat, EMOJI[e.id] || '😀', e.name);
  });

  socket.on('end', (e) => {
    game.over = true;
    stopCountdown();
    setTimeout(() => endScreen(e), 900);
    if (e.result === 'victory') sfx.victory();
    else if (e.result === 'defeat') sfx.defeat();
    else sfx.roundEnd();
  });

  socket.on('kicked', () => {
    leaveToLanding('You were kicked from the room.');
  });

  socket.on('errorMsg', (e) => {
    leaveToLanding(e.message);
  });

  socket.on('connect', after);
  socket.on('disconnect', () => {
    // Socket.IO retries; on reconnect we re-hello with our token.
    banner('Reconnecting…');
  });
  socket.io.on('reconnect', () => {
    if (game.code) {
      game.socket.emit('hello', { roomCode: game.code, playerToken: game.token, name: nameInput.value, hue: +hueInput.value });
    }
  });
}

function saveIdentity() {
  localStorage.setItem('jb-name', nameInput.value);
  localStorage.setItem('jb-hue', hueInput.value);
}

function leaveToLanding(message) {
  game.code = null;
  game.solo = false;
  stopCountdown();
  refreshSoloPicker();
  game.socket?.disconnect();
  game.socket = null;
  history.replaceState(null, '', '/');
  show('landing');
  const err = $('#landing-error');
  if (message) {
    err.textContent = message;
    err.hidden = false;
  }
}

// ---------- board / round ----------
function loadBoard(board) {
  game.grid.set(board.grid);
  game.owner.set(board.owner);
  game.pct = board.filled / TOTAL;
  game.level = board.level;
  game.mode = board.mode;
  game.timer = board.timer;
  game.turn = board.turn ?? null;
  game.lives = board.lives;
  game.powers = board.powers || [];
  game.powerups = board.powerups || [];
  game.latestTick = board.tick;
  game.tickOffsetMs = performance.now() - board.tick * tickMs;
  game.walls.clear();
  game.pendingWalls.clear();
  game.atoms.clear();
  for (const [id, x, y, vx, vy, type] of board.atoms) {
    game.atoms.set(id, { type, snaps: [{ t: board.tick, x, y, vx, vy }] });
  }
  for (const w of board.walls || []) {
    game.walls.set(w.id, {
      ...w,
      heads: {
        0: { cells: w.heads[0].done ? w.heads[0].cells : null, done: w.heads[0].done },
        1: { cells: w.heads[1].done ? w.heads[1].cells : null, done: w.heads[1].done },
      },
    });
  }
}

// One interval, recomputed from the clock each tick, cleared everywhere a
// round can stop — a thrown beep or a missed timeout can never strand a
// digit on screen.
let cdTimer = null;
function stopCountdown() {
  clearInterval(cdTimer);
  cdTimer = null;
  $('#countdown').hidden = true;
}

function runCountdown(startAt) {
  stopCountdown();
  const cd = $('#countdown');
  cd.hidden = false;
  let shown = null;
  const tick = () => {
    const left = Math.ceil((startAt - Date.now()) / 1000);
    if (left <= 0) {
      stopCountdown();
      banner(game.mode === 'party' ? `LEVEL ${game.level}` : `ROUND ${game.roundNo}`);
      try {
        sfx.go();
      } catch { /* audio may be locked pre-gesture */ }
      return;
    }
    if (left !== shown) {
      shown = left;
      cd.textContent = left;
      try {
        sfx.beep();
      } catch { /* audio may be locked pre-gesture */ }
    }
  };
  tick();
  cdTimer = setInterval(tick, 100);
}

function startRound(withCountdown, startAt) {
  game.over = false;
  show('game');
  renderer.reset();
  buildPowerSlots();
  updateHud();
  if (withCountdown && startAt) runCountdown(startAt);
  else stopCountdown();
}

// ---------- lobby UI ----------
function renderLobby() {
  $('#lobby-code').textContent = game.code || '';
  const ul = $('#lobby-players');
  ul.innerHTML = '';
  for (const p of game.players) {
    const li = document.createElement('li');
    if (p.ready) li.classList.add('ready');
    if (!p.connected) li.classList.add('gone');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `hsl(${p.hue} 80% 60%)`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${p.name}${p.seat === game.seat ? ' (you)' : ''}`;
    li.append(dot, who);
    if (p.host) {
      const chip = document.createElement('span');
      chip.className = 'tagchip';
      chip.textContent = 'host';
      li.append(chip);
    }
    const ready = document.createElement('span');
    ready.className = 'tagchip ready';
    ready.textContent = p.seat === -1 ? 'spectating' : p.ready ? 'ready' : 'not ready';
    li.append(ready);
    if (game.isHost && !p.host && p.seat !== -1) {
      const kick = document.createElement('button');
      kick.className = 'linkish';
      kick.textContent = 'kick';
      kick.onclick = () => game.socket.emit('host', { action: 'kick', seat: p.seat });
      li.append(kick);
    }
    ul.append(li);
  }
  $('#host-controls').hidden = !game.isHost;
  $('#level-row').style.display = game.mode === 'party' ? '' : 'none';
  for (const b of document.querySelectorAll('#mode-seg .seg-btn')) {
    b.classList.toggle('active', b.dataset.mode === game.mode);
  }
  const me = game.players.find((p) => p.seat === game.seat);
  $('#btn-ready').textContent = me?.ready ? 'Not ready' : "I'm ready";
}

// ---------- HUD ----------
function buildPowerSlots() {
  const wrap = $('#power-slots');
  wrap.innerHTML = '';
  if (game.mode !== 'party') return;
  for (let i = 0; i < 3; i++) {
    const b = document.createElement('button');
    b.dataset.slot = String(i);
    b.onclick = () => game.socket.emit('power', { slot: i });
    wrap.append(b);
  }
}

export function updateHud() {
  const left = $('#hud-left');
  const right = $('#hud-right');
  const bar = $('#fill-bar i');
  const barText = $('#fill-bar b');
  bar.style.width = `${Math.min(100, game.pct * 100).toFixed(1)}%`;
  barText.textContent = `${(game.pct * 100).toFixed(0)}%`;
  if (game.mode === 'party') {
    left.innerHTML = `<span>LV ${game.level}</span>` +
      `<span>${'❤'.repeat(Math.max(0, game.lives))}<span class="heart lost">${'❤'.repeat(Math.max(0, 8 - game.lives) > 8 ? 0 : 0)}</span></span>`;
    const hearts = document.createElement('span');
    left.innerHTML = `<span>LV ${game.level}</span>`;
    hearts.innerHTML = Array.from({ length: Math.max(game.lives, 0) }, () => '<span class="heart">❤</span>').join('');
    left.append(hearts);
    right.innerHTML = '';
    const slots = document.querySelectorAll('#power-slots button');
    slots.forEach((b, i) => {
      const kind = game.powers[i];
      b.textContent = kind ? POWER_ICON[kind] : '·';
      b.disabled = !kind;
      b.title = kind ? `${kind} (key ${i + 1})` : 'empty slot';
    });
  } else if (game.mode === 'duel') {
    const secs = game.turn ? Math.max(0, Math.ceil(game.turn.left / TICK_RATE)) : 0;
    const holder = game.turn ? game.turn.seat : -1;
    const mine = holder === game.seat;
    left.innerHTML = '';
    const chip = document.createElement('span');
    chip.className = 'turf-chip';
    chip.innerHTML = `<span class="dot" style="background:${seatColor(holder)}"></span>` +
      `<b>${mine ? 'YOUR TURN' : `${seatName(holder)}'s turn`}</b>` +
      `<span class="shot-clock${secs <= 5 ? ' low' : ''}">⏱ ${secs}s</span>`;
    left.append(chip);
    right.innerHTML = '';
    const counts = {};
    let filled = 0;
    for (let ci = 0; ci < TOTAL; ci++) {
      if (game.grid[ci] === CELL.FILLED) {
        counts[game.owner[ci] - 1] = (counts[game.owner[ci] - 1] || 0) + 1;
        filled++;
      }
    }
    for (const p of game.players) {
      if (p.seat === -1) continue;
      const t = document.createElement('span');
      t.className = 'turf-chip';
      const pctOf = filled ? Math.round(((counts[p.seat] || 0) / TOTAL) * 100) : 0;
      t.innerHTML = `<span class="dot" style="background:hsl(${p.hue} 80% 60%)"></span>${pctOf}%`;
      right.append(t);
    }
  } else {
    const secs = Math.max(0, Math.ceil(game.timer / TICK_RATE));
    left.innerHTML = `<span>⏱ ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</span>` +
      `<span>R${game.roundNo}</span>`;
    const mine = game.energy[game.seat];
    right.innerHTML = '';
    if (mine !== undefined) {
      const e = document.createElement('span');
      e.id = 'energy';
      e.innerHTML = `<i style="width:${mine}%"></i>`;
      right.append(e);
    }
    // Turf share per player.
    const counts = {};
    let filled = 0;
    for (let ci = 0; ci < TOTAL; ci++) {
      if (game.grid[ci] === CELL.FILLED) {
        counts[game.owner[ci] - 1] = (counts[game.owner[ci] - 1] || 0) + 1;
        filled++;
      }
    }
    for (const p of game.players) {
      if (p.seat === -1) continue;
      const chip = document.createElement('span');
      chip.className = 'turf-chip';
      const pctOf = filled ? Math.round(((counts[p.seat] || 0) / TOTAL) * 100) : 0;
      chip.innerHTML = `<span class="dot" style="background:hsl(${p.hue} 80% 60%)"></span>${pctOf}%`;
      right.append(chip);
    }
  }
}

// ---------- banners ----------
let bannerTimer = null;
export function banner(text) {
  const el = $('#banner');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.hidden = true), 1600);
}

// ---------- end screen ----------
function endScreen(e) {
  show('end');
  const title = $('#end-title');
  const podium = $('#podium');
  podium.innerHTML = '';
  if (game.mode === 'party') {
    title.textContent =
      e.result === 'victory' ? `Level ${e.level} cleared — ${Math.round(e.pct * 100)}%!` : `Run over at level ${e.level}`;
    if (e.next === 'level') {
      title.textContent += ' Next level…';
      $('#btn-rematch').hidden = true;
    } else {
      $('#btn-rematch').hidden = !game.isHost;
      $('#btn-rematch').textContent = game.solo ? `Play again (level ${e.level})` : 'New run';
    }
    if (game.solo) {
      const row = document.createElement('div');
      row.className = 'podium-row';
      row.textContent = `Reached level ${e.level} · Best level ${bestLevel()}`;
      podium.append(row);
      $('#btn-exit').textContent = 'invite friends';
    } else {
      $('#btn-exit').textContent = 'back to lobby';
    }
  } else {
    const scores = Object.entries(e.turf || {}).sort((a, b) => b[1] - a[1]);
    if (e.champion !== undefined && e.next === 'lobby') {
      title.textContent = `${seatName(+e.champion)} wins the match!`;
      $('#btn-rematch').hidden = !game.isHost;
      $('#btn-rematch').textContent = 'Rematch';
    } else {
      title.textContent = `Round ${e.roundNo} — next round soon…`;
      $('#btn-rematch').hidden = true;
    }
    scores.forEach(([seat, cells], i) => {
      const row = document.createElement('div');
      row.className = 'podium-row' + (i === 0 ? ' winner' : '');
      const wins = (e.roundWins || {})[seat] || 0;
      row.innerHTML = `<span class="dot" style="background:${seatColor(+seat)}"></span>` +
        `<b>${seatName(+seat)}</b><span>${Math.round((cells / TOTAL) * 100)}% turf</span>` +
        `<span>${'★'.repeat(wins)}</span>`;
      podium.append(row);
    });
  }
}

// ---------- wall building (prediction) ----------
export function requestBuild(cx, cy) {
  if (game.over || game.phase === 'lobby' || game.seat === -1) return;
  if (game.mode === 'duel' && (!game.turn || game.turn.seat !== game.seat)) return;
  if (cx < 0 || cx >= W || cy < 0 || cy >= H) return;
  if (game.grid[cy * W + cx] !== CELL.EMPTY) return;
  const seq = game.seq++;
  game.socket.emit('build', { seq, cx, cy, axis: game.axis });
  // Optimistic: render the wall growing from our tick estimate immediately.
  game.pendingWalls.set(seq, {
    cx,
    cy,
    axis: game.axis,
    who: game.seat,
    startTick: serverTickNow(),
    heads: { 0: { cells: null, done: false }, 1: { cells: null, done: false } },
  });
  sfx.click();
}

export function setAxis(axis) {
  game.axis = axis === 'h' ? 'h' : 'v';
  $('#btn-axis').textContent = game.axis === 'v' ? '⇕' : '⇔';
}

export function toggleAxis() {
  setAxis(game.axis === 'v' ? 'h' : 'v');
}

export function sendEmote(id) {
  game.socket?.emit('emote', { id });
  $('#emote-wheel').hidden = true;
}

// ---------- buttons ----------
$('#btn-solo').onclick = () => {
  saveIdentity();
  game.solo = true;
  connect(() => game.socket.emit('create', { mode: 'party', name: nameInput.value || 'Player', hue: +hueInput.value }));
};
$('#btn-create').onclick = () => {
  saveIdentity();
  game.solo = false;
  connect(() => game.socket.emit('create', { mode: 'party', name: nameInput.value, hue: +hueInput.value }));
};
$('#btn-join').onclick = () => {
  saveIdentity();
  const code = $('#code-input').value.trim().toUpperCase();
  if (code.length !== 6) return;
  connect(() => game.socket.emit('hello', { roomCode: code, name: nameInput.value, hue: +hueInput.value }));
};
$('#btn-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/r/${game.code}`);
    $('#copy-done').hidden = false;
    setTimeout(() => ($('#copy-done').hidden = true), 1500);
  } catch {
    prompt('Copy this link:', `${location.origin}/r/${game.code}`);
  }
};
$('#btn-ready').onclick = () => {
  const me = game.players.find((p) => p.seat === game.seat);
  game.socket.emit('ready', { ready: !me?.ready });
};
$('#btn-start').onclick = () => game.socket.emit('host', { action: 'start' });
$('#btn-leave').onclick = () => leaveToLanding();
$('#btn-exit').onclick = () => {
  game.solo = false; // "invite friends" from a solo run lands in the normal lobby
  renderLobby();
  show('lobby');
};
$('#btn-rematch').onclick = () => {
  if (game.solo) {
    // Same socket, ordered delivery: reset to lobby, pick up where we died,
    // start — the lobby never shows.
    game.socket.emit('host', { action: 'rematch' });
    game.socket.emit('host', { action: 'level', level: game.level });
    game.socket.emit('host', { action: 'start' });
    show('game');
    return;
  }
  game.socket.emit('host', { action: 'rematch' });
};
$('#level-input').onchange = (e) => game.socket.emit('host', { action: 'level', level: +e.target.value });
for (const b of document.querySelectorAll('#mode-seg .seg-btn')) {
  b.onclick = () => game.socket.emit('host', { action: 'mode', mode: b.dataset.mode });
}
{
  const wheel = $('#emote-wheel');
  EMOJI.forEach((em, i) => {
    const b = document.createElement('button');
    b.textContent = em;
    b.onclick = () => sendEmote(i);
    wheel.append(b);
  });
  $('#btn-emote').onclick = () => (wheel.hidden = !wheel.hidden);
}

// ---------- boot ----------
refreshSoloPicker();
const renderer = new Renderer($('#arena'), game);
attachInput($('#arena'), game, { requestBuild, toggleAxis, setAxis });
renderer.start();

const deepLink = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})$/);
if (deepLink) {
  $('#code-input').value = deepLink[1].toUpperCase();
  // Auto-join if we have a name already; otherwise let them type one first.
  if (nameInput.value) {
    connect(() =>
      game.socket.emit('hello', {
        roomCode: deepLink[1].toUpperCase(),
        playerToken: localStorage.getItem('jb-room') === deepLink[1].toUpperCase() ? game.token : undefined,
        name: nameInput.value,
        hue: +hueInput.value,
      })
    );
  }
}

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (screens.game.classList.contains('active')) {
    if (e.code === 'Space') {
      e.preventDefault();
      toggleAxis();
    }
    if (e.key >= '1' && e.key <= '3') game.socket?.emit('power', { slot: +e.key - 1 });
    if (e.key === 'e' || e.key === 'E') $('#emote-wheel').hidden = false;
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'e' || e.key === 'E') setTimeout(() => ($('#emote-wheel').hidden = true), 900);
});
