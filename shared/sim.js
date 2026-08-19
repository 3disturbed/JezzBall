// JezzBall simulation — pure, deterministic, shared by server (authority) and
// client (prediction). No wall-clock, no Math.random: everything advances by
// integer ticks and a seeded PRNG. See docs/SDD.md §3.5.

export const W = 48;
export const H = 30;
export const TOTAL = W * H;
export const TICK_RATE = 30;
export const WALL_SPEED = 12; // cells per second
export const SNAP_EVERY = 2; // snapshots every N ticks (15 Hz)

export const CELL = { EMPTY: 0, WET: 1, SOLID: 2, FILLED: 3 };

export const MODES = {
  party: {
    target: 0.75,
    baseLives: 3, // + player count
    comboWindow: Math.round(1.5 * TICK_RATE),
  },
  turf: {
    roundTicks: 150 * TICK_RATE, // 2:30
    hurryTicks: 30 * TICK_RATE, // last 30 s: atoms speed up
    hurryFactor: 1.25,
    energyMax: 100,
    buildCost: 25,
    shatterSting: 10,
    regenPerTick: 10 / TICK_RATE,
    comboWindow: Math.round(1.5 * TICK_RATE),
  },
  // Turn-based versus: one wall per turn under a 30 s shot clock. The atoms
  // never stop — only the building is gated. Match ends at 75% total fill;
  // most territory wins.
  duel: {
    target: 0.75,
    turnTicks: 30 * TICK_RATE,
    comboWindow: Math.round(1.5 * TICK_RATE),
  },
};

export const ATOM = {
  standard: { r: 0.4, speed: 6 },
  mini: { r: 0.3, speed: 7 },
  splitter: { r: 0.45, speed: 5.5 },
  brute: { r: 0.55, speed: 4.5 },
  wisp: { r: 0.35, speed: 6.5 },
};

export const POWERS = ['freeze', 'quickset', 'ghost'];

// mulberry32 — tiny seeded PRNG, good enough for gameplay.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const idx = (cx, cy) => cy * W + cx;
export const inBounds = (cx, cy) => cx >= 0 && cx < W && cy >= 0 && cy < H;

// Hazard mix per Party level (SDD §2.2: one new type roughly every 3 levels).
export function partyAtomTypes(level, count, rng) {
  const types = [];
  for (let i = 0; i < count; i++) {
    let t = 'standard';
    if (level >= 3 && i === count - 1) t = 'splitter';
    if (level >= 6 && i === count - 2) t = 'brute';
    if (level >= 9 && i === count - 3) t = 'wisp';
    if (level >= 12 && rng() < 0.2) t = ['splitter', 'brute', 'wisp'][Math.floor(rng() * 3)];
    types.push(t);
  }
  return types;
}

export function createGame({ mode, seed, seats, level = 1 }) {
  const rng = makeRng(seed);
  const state = {
    mode,
    seed,
    level,
    tick: 0,
    rng,
    grid: new Uint8Array(TOTAL),
    // For FILLED cells: seat + 1 of the capturer. For SOLID cells: seat + 1
    // of the wall builder (colors the wall client-side). 0 = none.
    owner: new Uint8Array(TOTAL),
    wetOwner: new Int32Array(TOTAL).fill(-1), // cell -> wall id while WET
    atoms: [],
    walls: new Map(),
    nextWallId: 1,
    nextAtomId: 1,
    filled: 0,
    players: new Map(), // seat -> {seat, energy, captured}
    team: { lives: 0, powers: [], nextQuickset: false, nextGhost: false },
    freezeUntil: 0,
    powerups: [], // {id, cx, cy, kind}
    nextPowerId: 1,
    nextPowerAt: 0,
    lastCaptureTick: -9999,
    comboCount: 0,
    timer: 0,
    hurried: false,
    turn: null, // duel: {seat, ticksLeft, wallId}
    turnOrder: [],
    over: false,
  };

  for (const s of seats) {
    state.players.set(s.seat, { seat: s.seat, energy: MODES.turf.energyMax, captured: 0 });
  }

  const nSeats = Math.max(1, seats.length);
  let atomTypes;
  if (mode === 'party') {
    state.team.lives = MODES.party.baseLives + nSeats;
    atomTypes = partyAtomTypes(level, 2 + level, rng);
    state.nextPowerAt = 20 * TICK_RATE;
  } else {
    atomTypes = Array(4 + 2 * nSeats).fill('standard');
    if (mode === 'turf') {
      state.timer = MODES.turf.roundTicks;
    } else {
      state.turnOrder = seats.map((s) => s.seat).sort((a, b) => a - b);
      state.turn = { seat: state.turnOrder[0], ticksLeft: MODES.duel.turnTicks, wallId: null };
    }
  }

  for (const t of atomTypes) spawnAtom(state, t);
  return state;
}

function spawnAtom(state, type, at) {
  const spec = ATOM[type];
  const a = {
    id: state.nextAtomId++,
    type,
    r: spec.r,
    x: at ? at.x : 2 + state.rng() * (W - 4),
    y: at ? at.y : 2 + state.rng() * (H - 4),
    vx: 0,
    vy: 0,
    hits: 0, // brute: wet-wall contacts survived
  };
  const ang = state.rng() * Math.PI * 2;
  const sp = spec.speed * (state.hurried ? MODES.turf.hurryFactor : 1);
  a.vx = Math.cos(ang) * sp;
  a.vy = Math.sin(ang) * sp;
  // Avoid near-axis angles that make degenerate, boring bounces.
  if (Math.abs(a.vx) < sp * 0.25) {
    a.vx = Math.sign(a.vx || 1) * sp * 0.35;
    a.vy = Math.sign(a.vy || 1) * Math.sqrt(sp * sp - a.vx * a.vx);
  }
  state.atoms.push(a);
  return a;
}

function blockedForAtom(state, cx, cy, atom, wetTransparent) {
  if (!inBounds(cx, cy)) return 'edge';
  const c = state.grid[idx(cx, cy)];
  if (c === CELL.SOLID || c === CELL.FILLED) return 'solid';
  if (c === CELL.WET) {
    const wall = state.walls.get(state.wetOwner[idx(cx, cy)]);
    if (wall && wall.ghost) return null; // ghost walls: atoms pass through wet cells
    if (atom.type === 'wisp') return null; // wisps pass through wet cells
    if (wetTransparent) return null;
    return 'wet';
  }
  return null;
}

// Move one atom along one axis; returns the kind of surface hit (or null).
function sweepAxis(state, a, axis, dt, events) {
  const step = axis === 'x' ? a.vx * dt : a.vy * dt;
  if (step === 0) return;
  const nx = axis === 'x' ? a.x + step : a.x;
  const ny = axis === 'y' ? a.y + step : a.y;
  // Cells overlapped by the circle at the new position.
  const minCx = Math.floor(nx - a.r);
  const maxCx = Math.floor(nx + a.r);
  const minCy = Math.floor(ny - a.r);
  const maxCy = Math.floor(ny + a.r);
  let hit = null;
  let hitWet = null;
  for (let cy = minCy; cy <= maxCy && !hit; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const b = blockedForAtom(state, cx, cy, a, false);
      if (b === 'wet') hitWet = { cx, cy };
      if (b === 'solid' || b === 'edge') {
        hit = b;
        break;
      }
    }
  }
  if (hitWet) {
    onWetContact(state, a, hitWet, events);
    // Re-evaluate: the wet cells may be gone now (shattered) — if the cell is
    // clear the atom keeps moving this axis, otherwise it reflects below.
    if (blockedForAtom(state, hitWet.cx, hitWet.cy, a, false)) hit = hit || 'wet';
  }
  if (hit) {
    if (axis === 'x') a.vx = -a.vx;
    else a.vy = -a.vy;
  } else {
    a.x = nx;
    a.y = ny;
  }
}

function onWetContact(state, atom, { cx, cy }, events) {
  const wallId = state.wetOwner[idx(cx, cy)];
  const wall = state.walls.get(wallId);
  if (!wall) return;
  const head = wall.heads.find((h) => !h.done && h.cells.includes(idx(cx, cy)));
  if (!head) return;
  if (atom.type === 'brute' && head.bruteHits === 0) {
    head.bruteHits = 1;
    head.stun = TICK_RATE; // pause growth 1 s; second contact shatters
    events.push({ type: 'stun', wall: wallId, head: head.dirIdx });
    return;
  }
  shatterHead(state, wall, head, events);
}

function shatterHead(state, wall, head, events) {
  for (const ci of head.cells) {
    state.grid[ci] = CELL.EMPTY;
    state.wetOwner[ci] = -1;
  }
  events.push({
    type: 'shatter',
    wall: wall.id,
    head: head.dirIdx,
    cells: head.cells.slice(),
    who: wall.who,
  });
  head.cells = [];
  head.done = true;
  head.shattered = true;
  // Both heads gone with nothing set solid -> the wall is fully dead.
  if (wall.heads.every((h) => h.shattered)) state.walls.delete(wall.id);
  if (state.mode === 'party') {
    state.team.lives -= 1;
    events.push({ type: 'lives', lives: state.team.lives });
    if (state.team.lives <= 0) {
      state.over = true;
      events.push({ type: 'end', result: 'defeat' });
    }
  } else {
    const p = state.players.get(wall.who);
    if (p) p.energy = Math.max(0, p.energy - MODES.turf.shatterSting);
  }
}

export function tryBuild(state, seat, cx, cy, axis) {
  if (state.over) return { ok: false, reason: 'over' };
  if (!inBounds(cx, cy)) return { ok: false, reason: 'bounds' };
  if (state.grid[idx(cx, cy)] !== CELL.EMPTY) return { ok: false, reason: 'occupied' };
  if (axis !== 'h' && axis !== 'v') return { ok: false, reason: 'axis' };
  // An atom overlapping the seed cell shatters the wall instantly anyway;
  // reject so the client can grey the cell out instead.
  for (const a of state.atoms) {
    if (Math.floor(a.x) === cx && Math.floor(a.y) === cy) return { ok: false, reason: 'atom' };
  }
  if (state.mode === 'turf') {
    const p = state.players.get(seat);
    if (!p) return { ok: false, reason: 'seat' };
    if (p.energy < MODES.turf.buildCost) return { ok: false, reason: 'energy' };
    p.energy -= MODES.turf.buildCost;
  }
  if (state.mode === 'duel') {
    if (!state.turn || state.turn.seat !== seat) return { ok: false, reason: 'turn' };
    if (state.turn.wallId !== null) return { ok: false, reason: 'placed' };
  }
  const wall = {
    id: state.nextWallId++,
    who: seat,
    axis,
    cx,
    cy,
    startTick: state.tick,
    ghost: state.team.nextGhost,
    quickset: state.team.nextQuickset,
    heads: [
      { dirIdx: 0, dir: -1, prog: 0, cells: [], done: false, shattered: false, stun: 0, bruteHits: 0 },
      { dirIdx: 1, dir: 1, prog: 0, cells: [], done: false, shattered: false, stun: 0, bruteHits: 0 },
    ],
  };
  state.team.nextGhost = false;
  state.team.nextQuickset = false;
  // The seed cell belongs to head 0 so a hit on it resolves to one head.
  state.grid[idx(cx, cy)] = CELL.WET;
  state.wetOwner[idx(cx, cy)] = wall.id;
  wall.heads[0].cells.push(idx(cx, cy));
  state.walls.set(wall.id, wall);
  if (state.mode === 'duel') state.turn.wallId = wall.id;
  return { ok: true, wall };
}

// Duel: hand the turn to the next seat. The shot clock only runs while no
// wall is pending — once placed, the turn ends when the wall resolves.
function advanceTurn(state, events, passed) {
  const order = state.turnOrder;
  const prev = state.turn.seat;
  const next = order[(order.indexOf(prev) + 1) % order.length];
  state.turn = { seat: next, ticksLeft: MODES.duel.turnTicks, wallId: null };
  events.push({ type: 'turn', seat: next, prev, passed });
}

// Room-level escape hatch: skip a disconnected player's turn immediately.
export function passTurn(state) {
  const events = [];
  if (!state.over && state.mode === 'duel' && state.turn) advanceTurn(state, events, true);
  return events;
}

function advanceWalls(state, events) {
  const speed = WALL_SPEED / TICK_RATE;
  for (const wall of [...state.walls.values()]) {
    let completedNow = false;
    for (const head of wall.heads) {
      if (head.done) continue;
      if (head.stun > 0) {
        head.stun--;
        continue;
      }
      head.prog += wall.quickset ? speed * 2 : speed;
      while (head.prog >= head.cells.length + (head.dirIdx === 0 ? 0 : 1)) {
        // Next cell outward from the seed.
        const n = head.cells.length + (head.dirIdx === 0 ? 0 : 1);
        const cx = wall.axis === 'h' ? wall.cx + head.dir * n : wall.cx;
        const cy = wall.axis === 'v' ? wall.cy + head.dir * n : wall.cy;
        if (!inBounds(cx, cy) || state.grid[idx(cx, cy)] === CELL.SOLID || state.grid[idx(cx, cy)] === CELL.FILLED) {
          // Head reached an edge/solid: set this head's cells solid.
          setHeadSolid(state, wall, head, events);
          break;
        }
        if (state.grid[idx(cx, cy)] === CELL.WET) {
          // Ran into another growing wall: stop here, set solid.
          setHeadSolid(state, wall, head, events);
          break;
        }
        state.grid[idx(cx, cy)] = CELL.WET;
        state.wetOwner[idx(cx, cy)] = wall.id;
        head.cells.push(idx(cx, cy));
        // Growing into an atom shatters the head just like an atom moving
        // into the wall would (ghost walls and wisps excepted).
        if (!wall.ghost && claimTouchesAtom(state, cx, cy)) {
          onWetContact(state, claimTouchesAtom(state, cx, cy), { cx, cy }, events);
          if (head.done || state.over) break;
        }
      }
    }
    if (wall.heads.every((h) => h.done) && state.walls.has(wall.id)) {
      completedNow = wall.heads.some((h) => !h.shattered && h.solidified);
      if (completedNow) {
        for (const h of wall.heads) h.solidified = false; // consumed
        capture(state, wall, events);
      }
      state.walls.delete(wall.id);
    }
  }
}

function claimTouchesAtom(state, cx, cy) {
  for (const a of state.atoms) {
    if (a.type === 'wisp') continue;
    const nx = Math.max(cx, Math.min(a.x, cx + 1));
    const ny = Math.max(cy, Math.min(a.y, cy + 1));
    const dx = a.x - nx;
    const dy = a.y - ny;
    if (dx * dx + dy * dy < a.r * a.r) return a;
  }
  return null;
}

function setHeadSolid(state, wall, head, events) {
  for (const ci of head.cells) {
    state.grid[ci] = CELL.SOLID;
    state.owner[ci] = wall.who + 1;
    state.wetOwner[ci] = -1;
  }
  head.done = true;
  head.solidified = true;
  events.push({ type: 'set', wall: wall.id, head: head.dirIdx, cells: head.cells.slice(), who: wall.who });
}

// Flood fill from every atom over EMPTY|WET; unreached EMPTY cells fill.
function capture(state, wall, events) {
  const reach = new Uint8Array(TOTAL);
  const queue = [];
  const atomRegionMark = new Map(); // atom id -> mark value for splitter check
  let mark = 1;
  for (const a of state.atoms) {
    const ci = idx(
      Math.min(W - 1, Math.max(0, Math.floor(a.x))),
      Math.min(H - 1, Math.max(0, Math.floor(a.y)))
    );
    if (state.grid[ci] !== CELL.EMPTY && state.grid[ci] !== CELL.WET) {
      // Atom is visually on a wall edge; find a neighboring open cell.
      const cx = Math.floor(a.x), cy = Math.floor(a.y);
      let found = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (inBounds(cx + dx, cy + dy)) {
          const ni = idx(cx + dx, cy + dy);
          if (state.grid[ni] === CELL.EMPTY || state.grid[ni] === CELL.WET) {
            found = ni;
            break;
          }
        }
      }
      if (found === -1) continue;
      atomRegionMark.set(a.id, reach[found] || mark);
      if (!reach[found]) queue.push(found), (reach[found] = mark++);
      continue;
    }
    if (!reach[ci]) {
      reach[ci] = mark++;
      queue.push(ci);
    }
    atomRegionMark.set(a.id, reach[ci]);
  }
  while (queue.length) {
    const ci = queue.pop();
    const cx = ci % W;
    const cy = (ci / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (reach[ni]) continue;
      if (state.grid[ni] === CELL.EMPTY || state.grid[ni] === CELL.WET) {
        reach[ni] = reach[ci];
        queue.push(ni);
      }
    }
  }
  const gained = [];
  for (let ci = 0; ci < TOTAL; ci++) {
    if (state.grid[ci] === CELL.EMPTY && !reach[ci]) {
      state.grid[ci] = CELL.FILLED;
      state.owner[ci] = wall.who + 1;
      gained.push(ci);
    }
  }
  if (!gained.length) return;
  state.filled += gained.length;

  // Combo window (any capturer chains it — co-op by design).
  if (state.tick - state.lastCaptureTick <= MODES[state.mode].comboWindow) state.comboCount++;
  else state.comboCount = 1;
  state.lastCaptureTick = state.tick;

  const p = state.players.get(wall.who);
  if (p) p.captured += gained.length;

  events.push({
    type: 'capture',
    cells: gained,
    who: wall.who,
    pct: state.filled / TOTAL,
    combo: state.comboCount,
  });

  // Power-up pickups sealed into territory are collected.
  for (let i = state.powerups.length - 1; i >= 0; i--) {
    const pu = state.powerups[i];
    if (state.grid[idx(pu.cx, pu.cy)] === CELL.FILLED) {
      state.powerups.splice(i, 1);
      if (state.team.powers.length < 3) {
        state.team.powers.push(pu.kind);
        events.push({ type: 'power', kind: pu.kind, powers: state.team.powers.slice() });
      }
    }
  }

  // Splitters adjacent to the sealed area split (SDD §2.2: capture them last).
  if (state.mode === 'party') {
    const gainedSet = new Set(gained);
    for (const a of [...state.atoms]) {
      if (a.type !== 'splitter') continue;
      const cx = Math.floor(a.x);
      const cy = Math.floor(a.y);
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (gainedSet.has(idx(cx + dx, cy + dy))) {
            near = true;
            break;
          }
      if (near) {
        state.atoms.splice(state.atoms.indexOf(a), 1);
        const c1 = spawnAtom(state, 'mini', { x: a.x, y: a.y });
        const c2 = spawnAtom(state, 'mini', { x: a.x, y: a.y });
        c2.vx = -c1.vx;
        c2.vy = -c1.vy;
        events.push({ type: 'split', at: { x: a.x, y: a.y }, ids: [c1.id, c2.id] });
      }
    }
  }

  if (state.mode === 'party' && state.filled / TOTAL >= MODES.party.target) {
    state.over = true;
    events.push({ type: 'end', result: 'victory' });
  }
  if (state.mode === 'duel' && state.filled / TOTAL >= MODES.duel.target) {
    state.over = true;
    events.push({ type: 'end', result: 'filled', turf: turfScores(state) });
  }
}

export function triggerPower(state, _seat, slot) {
  if (state.mode !== 'party') return { ok: false };
  const kind = state.team.powers[slot];
  if (!kind) return { ok: false };
  state.team.powers.splice(slot, 1);
  if (kind === 'freeze') state.freezeUntil = state.tick + 4 * TICK_RATE;
  if (kind === 'quickset') state.team.nextQuickset = true;
  if (kind === 'ghost') state.team.nextGhost = true;
  return { ok: true, kind, powers: state.team.powers.slice() };
}

export function step(state) {
  const events = [];
  if (state.over) return events;
  state.tick++;
  const dt = 1 / TICK_RATE;

  advanceWalls(state, events);

  const frozen = state.tick < state.freezeUntil;
  const speedScale = frozen ? 0.25 : 1;
  for (const a of state.atoms) {
    const saveVx = a.vx;
    const saveVy = a.vy;
    a.vx *= speedScale;
    a.vy *= speedScale;
    sweepAxis(state, a, 'x', dt, events);
    sweepAxis(state, a, 'y', dt, events);
    // Restore full speed but keep any reflections from this tick.
    a.vx = Math.sign(a.vx) * Math.abs(saveVx);
    a.vy = Math.sign(a.vy) * Math.abs(saveVy);
    if (state.over) break; // a shatter may have ended the run
  }

  if (state.mode === 'turf' && !state.over) {
    for (const p of state.players.values()) {
      p.energy = Math.min(MODES.turf.energyMax, p.energy + MODES.turf.regenPerTick);
    }
    state.timer--;
    if (!state.hurried && state.timer <= MODES.turf.hurryTicks) {
      state.hurried = true;
      for (const a of state.atoms) {
        a.vx *= MODES.turf.hurryFactor;
        a.vy *= MODES.turf.hurryFactor;
      }
      events.push({ type: 'hurry' });
    }
    if (state.timer <= 0) {
      state.over = true;
      events.push({ type: 'end', result: 'timeup', turf: turfScores(state) });
    }
  }

  if (state.mode === 'duel' && !state.over && state.turn) {
    const t = state.turn;
    if (t.wallId !== null) {
      if (!state.walls.has(t.wallId)) advanceTurn(state, events, false);
    } else {
      t.ticksLeft--;
      if (t.ticksLeft <= 0) advanceTurn(state, events, true);
    }
  }

  if (state.mode === 'party' && !state.over && state.tick >= state.nextPowerAt) {
    state.nextPowerAt = state.tick + 20 * TICK_RATE;
    if (state.powerups.length < 1) {
      // Find a random EMPTY cell away from the border.
      for (let tries = 0; tries < 40; tries++) {
        const cx = 2 + Math.floor(state.rng() * (W - 4));
        const cy = 2 + Math.floor(state.rng() * (H - 4));
        if (state.grid[idx(cx, cy)] === CELL.EMPTY) {
          const pu = {
            id: state.nextPowerId++,
            cx,
            cy,
            kind: POWERS[Math.floor(state.rng() * POWERS.length)],
          };
          state.powerups.push(pu);
          events.push({ type: 'powerSpawn', pu });
          break;
        }
      }
    }
  }

  return events;
}

export function turfScores(state) {
  const counts = {};
  for (const seat of state.players.keys()) counts[seat] = 0;
  for (let ci = 0; ci < TOTAL; ci++) {
    if (state.grid[ci] === CELL.FILLED) {
      const seat = state.owner[ci] - 1;
      if (seat in counts) counts[seat]++;
    }
  }
  return counts;
}

export function snapshotAtoms(state) {
  return state.atoms.map((a) => [
    a.id,
    Math.round(a.x * 100) / 100,
    Math.round(a.y * 100) / 100,
    Math.round(a.vx * 100) / 100,
    Math.round(a.vy * 100) / 100,
    a.type,
  ]);
}

// Compact full-board serialization for welcome/rejoin.
export function serializeBoard(state) {
  return {
    grid: Array.from(state.grid),
    owner: Array.from(state.owner),
    filled: state.filled,
    tick: state.tick,
    level: state.level,
    mode: state.mode,
    timer: state.timer,
    turn: state.turn ? { seat: state.turn.seat, left: state.turn.ticksLeft } : undefined,
    lives: state.team.lives,
    powers: state.team.powers.slice(),
    powerups: state.powerups.map((p) => ({ ...p })),
    atoms: snapshotAtoms(state),
    energy: Object.fromEntries([...state.players.values()].map((p) => [p.seat, Math.round(p.energy)])),
    walls: [...state.walls.values()].map((w) => ({
      id: w.id,
      who: w.who,
      axis: w.axis,
      cx: w.cx,
      cy: w.cy,
      startTick: w.startTick,
      heads: w.heads.map((h) => ({ dirIdx: h.dirIdx, cells: h.cells.slice(), done: h.done })),
    })),
  };
}

// Deterministic state hash for tests.
export function hashState(state) {
  let h = 2166136261 >>> 0;
  const mix = (n) => {
    h ^= n >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(state.tick);
  mix(state.filled);
  for (let i = 0; i < TOTAL; i++) mix(state.grid[i] + i * 7);
  for (const a of state.atoms) {
    mix(a.id);
    mix(Math.round(a.x * 1000));
    mix(Math.round(a.y * 1000));
    mix(Math.round(a.vx * 1000));
    mix(Math.round(a.vy * 1000));
  }
  return h;
}
