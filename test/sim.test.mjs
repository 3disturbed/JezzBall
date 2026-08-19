import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  W,
  H,
  TOTAL,
  CELL,
  TICK_RATE,
  createGame,
  step,
  tryBuild,
  triggerPower,
  hashState,
  turfScores,
  idx,
  makeRng,
} from '../shared/sim.js';

function game(overrides = {}) {
  return createGame({
    mode: 'party',
    seed: 1234,
    seats: [{ seat: 0 }],
    level: 1,
    ...overrides,
  });
}

// Park all atoms in a corner, motionless, so walls can grow undisturbed.
function parkAtoms(state, x = 1.5, y = 1.5) {
  for (const a of state.atoms) {
    a.x = x;
    a.y = y;
    a.vx = 0;
    a.vy = 0;
  }
}

function runTicks(state, n) {
  const all = [];
  for (let i = 0; i < n; i++) all.push(...step(state));
  return all;
}

test('rng is deterministic', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 1000; i++) assert.equal(a(), b());
});

test('atoms stay in bounds for 10k ticks', () => {
  const state = game({ seed: 99, level: 5 });
  for (let i = 0; i < 10000; i++) step(state);
  for (const a of state.atoms) {
    assert.ok(a.x > 0 && a.x < W, `x in bounds: ${a.x}`);
    assert.ok(a.y > 0 && a.y < H, `y in bounds: ${a.y}`);
  }
});

test('vertical wall completes and captures the empty side', () => {
  const state = game();
  parkAtoms(state, 2.5, 2.5); // atoms on the left side
  const r = tryBuild(state, 0, 10, 15, 'v');
  assert.ok(r.ok);
  // Wall spans H=30 cells at 12 cells/s -> ~2.5s. Run 4s.
  const events = runTicks(state, 4 * TICK_RATE);
  const sets = events.filter((e) => e.type === 'set');
  assert.equal(sets.length, 2, 'both heads set');
  const captures = events.filter((e) => e.type === 'capture');
  assert.equal(captures.length, 1, 'one capture');
  // Right side of x=10 = columns 11..47 = 37 * 30 cells.
  assert.equal(captures[0].cells.length, 37 * H);
  assert.equal(captures[0].who, 0);
  // Grid actually filled, owner recorded.
  assert.equal(state.grid[idx(20, 15)], CELL.FILLED);
  assert.equal(state.owner[idx(20, 15)], 1);
  // Fill percentage well past 75% -> level over.
  assert.ok(state.filled / TOTAL >= 0.75);
  assert.ok(events.some((e) => e.type === 'end' && e.result === 'victory'));
});

test('atom shatters a growing wall and costs a team life', () => {
  const state = game();
  parkAtoms(state, 24.5, 10.5);
  // Atom sits dead ahead of the upward head's path at x=24.
  const livesBefore = state.team.lives;
  const r = tryBuild(state, 0, 24, 20, 'v');
  assert.ok(r.ok);
  const events = runTicks(state, 3 * TICK_RATE);
  const shatters = events.filter((e) => e.type === 'shatter');
  assert.ok(shatters.length >= 1, 'wall head shattered');
  assert.equal(state.team.lives, livesBefore - 1);
  // Shattered cells are empty again.
  for (const ci of shatters[0].cells) assert.equal(state.grid[ci], CELL.EMPTY);
});

test('capture flood fill respects nested chambers (golden grid)', () => {
  const state = game();
  parkAtoms(state, 2.5, 2.5);
  // First wall: vertical at x=30 -> captures right side.
  tryBuild(state, 0, 30, 15, 'v');
  runTicks(state, 4 * TICK_RATE);
  state.over = false; // keep playing past the 75% victory for the fixture
  const filledBefore = state.filled;
  // Second wall: vertical at x=15 -> captures the 16..29 corridor.
  tryBuild(state, 0, 15, 15, 'v');
  const events = runTicks(state, 4 * TICK_RATE);
  const cap = events.find((e) => e.type === 'capture');
  assert.ok(cap, 'second capture happened');
  // Columns 16..29 * 30 rows.
  assert.equal(cap.cells.length, 14 * H);
  assert.ok(state.filled > filledBefore);
  // Atom side (columns 0..14) never filled.
  assert.equal(state.grid[idx(5, 5)], CELL.EMPTY);
});

test('no capture when atoms remain on both sides', () => {
  const state = game({ seed: 7 });
  // Two atoms, one parked each side of the wall line.
  state.atoms.length = 0;
  state.nextAtomId = 1;
  state.atoms.push(
    { id: 1, type: 'standard', r: 0.4, x: 5, y: 5, vx: 0, vy: 0, hits: 0 },
    { id: 2, type: 'standard', r: 0.4, x: 40, y: 5, vx: 0, vy: 0, hits: 0 }
  );
  tryBuild(state, 0, 20, 15, 'v');
  const events = runTicks(state, 4 * TICK_RATE);
  assert.ok(events.some((e) => e.type === 'set'));
  assert.ok(!events.some((e) => e.type === 'capture'), 'no region without atoms');
});

test('capture target is 60%: 60.4% wins, 56.2% does not', () => {
  // x=20: captures cols 21..47 = 27*30 = 810 cells = 56.2% -> no victory.
  const under = game();
  parkAtoms(under, 2.5, 2.5);
  tryBuild(under, 0, 20, 15, 'v');
  const underEvents = runTicks(under, 4 * TICK_RATE);
  assert.ok(underEvents.some((e) => e.type === 'capture'));
  assert.ok(!underEvents.some((e) => e.type === 'end'), '56% must not clear the level');
  assert.equal(under.over, false);
  // x=18: captures cols 19..47 = 29*30 = 870 cells = 60.4% -> victory.
  const over = game();
  parkAtoms(over, 2.5, 2.5);
  tryBuild(over, 0, 18, 15, 'v');
  const overEvents = runTicks(over, 4 * TICK_RATE);
  assert.ok(overEvents.some((e) => e.type === 'end' && e.result === 'victory'), '60.4% clears the level');
});

test('determinism: same seed + same script => same hash', () => {
  const run = () => {
    const state = game({ seed: 555, level: 4 });
    tryBuild(state, 0, 10, 10, 'v');
    for (let i = 0; i < 10000; i++) {
      step(state);
      if (i === 200) tryBuild(state, 0, 30, 20, 'h');
      if (i === 500) tryBuild(state, 0, 40, 5, 'v');
      state.over = false; // keep sim advancing regardless of outcomes
    }
    return hashState(state);
  };
  assert.equal(run(), run());
});

test('build rejections: bounds, occupied, atom cell, energy', () => {
  const state = game();
  assert.equal(tryBuild(state, 0, -1, 5, 'v').ok, false);
  assert.equal(tryBuild(state, 0, 5, 5, 'x').ok, false);
  const a = state.atoms[0];
  assert.equal(tryBuild(state, 0, Math.floor(a.x), Math.floor(a.y), 'v').ok, false);
  // Occupied: build then immediately build on the seed cell.
  parkAtoms(state, 2.5, 2.5);
  assert.ok(tryBuild(state, 0, 20, 15, 'v').ok);
  assert.equal(tryBuild(state, 0, 20, 15, 'h').ok, false);

  const turf = createGame({ mode: 'turf', seed: 1, seats: [{ seat: 0 }, { seat: 1 }] });
  parkAtoms(turf, 2.5, 2.5);
  const p = turf.players.get(0);
  p.energy = 10; // below cost
  assert.equal(tryBuild(turf, 0, 20, 15, 'v').ok, false);
  p.energy = 30;
  assert.ok(tryBuild(turf, 0, 20, 15, 'v').ok);
  assert.ok(p.energy < 10);
});

test('turf: capture ownership, scores and timer end', () => {
  const state = createGame({ mode: 'turf', seed: 3, seats: [{ seat: 0 }, { seat: 1 }] });
  parkAtoms(state, 2.5, 2.5);
  tryBuild(state, 1, 35, 15, 'v');
  runTicks(state, 4 * TICK_RATE);
  const scores = turfScores(state);
  assert.ok(scores[1] > 0, 'seat 1 owns captured turf');
  assert.equal(scores[0], 0);
  // Fast-forward the timer.
  state.timer = 3;
  const events = runTicks(state, 5);
  const end = events.find((e) => e.type === 'end');
  assert.ok(end && end.result === 'timeup');
  assert.equal(end.turf[1], scores[1]);
});

test('turf: energy regenerates', () => {
  const state = createGame({ mode: 'turf', seed: 3, seats: [{ seat: 0 }] });
  parkAtoms(state, 2.5, 2.5);
  const p = state.players.get(0);
  p.energy = 0;
  runTicks(state, TICK_RATE); // 1 second
  assert.ok(p.energy >= 9 && p.energy <= 11, `regen ~10/s, got ${p.energy}`);
});

test('freeze power slows atoms', () => {
  const state = game();
  state.team.powers = ['freeze'];
  const a = state.atoms[0];
  a.x = 24;
  a.y = 15;
  a.vx = 6;
  a.vy = 0;
  const r = triggerPower(state, 0, 0);
  assert.ok(r.ok);
  const x0 = a.x;
  runTicks(state, 10);
  const moved = Math.abs(a.x - x0);
  assert.ok(moved < 0.6, `frozen atom moved ${moved} cells in 10 ticks`);
});

test('ghost wall cannot be shattered', () => {
  const state = game();
  parkAtoms(state, 24.5, 10.5);
  state.team.powers = ['ghost'];
  triggerPower(state, 0, 0);
  tryBuild(state, 0, 24, 20, 'v');
  const events = runTicks(state, 4 * TICK_RATE);
  assert.ok(!events.some((e) => e.type === 'shatter'), 'ghost wall survived');
  assert.ok(events.some((e) => e.type === 'set'));
});

test('splitter splits into two minis on nearby capture', () => {
  const state = game({ level: 3, seed: 11 });
  // Level 3 spawns one splitter.
  const splitter = state.atoms.find((a) => a.type === 'splitter');
  assert.ok(splitter, 'level 3 has a splitter');
  parkAtoms(state, 2.5, 2.5);
  // Park the splitter right beside the region that will be captured.
  splitter.x = 34.5;
  splitter.y = 15.5;
  // Wall at x=36: captures columns 37..47; splitter at 34 is within 2 cells of the wall side? No —
  // captured cells start at 37, distance 3. Park closer:
  splitter.x = 35.5;
  const before = state.atoms.length;
  tryBuild(state, 0, 36, 15, 'v');
  const events = runTicks(state, 4 * TICK_RATE);
  const split = events.find((e) => e.type === 'split');
  assert.ok(split, 'splitter split');
  assert.equal(state.atoms.length, before + 1); // -1 splitter +2 minis
  assert.ok(!state.atoms.includes(splitter));
});

test('duel: turn gating and one wall per turn', () => {
  const state = createGame({ mode: 'duel', seed: 5, seats: [{ seat: 0 }, { seat: 1 }] });
  parkAtoms(state, 2.5, 2.5);
  assert.equal(state.turn.seat, 0);
  // Out-of-turn build rejected.
  assert.equal(tryBuild(state, 1, 30, 15, 'v').reason, 'turn');
  // In-turn build accepted; a second wall the same turn is rejected.
  assert.ok(tryBuild(state, 0, 30, 15, 'v').ok);
  assert.equal(tryBuild(state, 0, 40, 15, 'v').reason, 'placed');
  // Shot clock freezes while the wall grows.
  const before = state.turn.ticksLeft;
  runTicks(state, 10);
  assert.equal(state.turn.ticksLeft, before);
  // Wall resolves (sets + captures) -> turn passes to seat 1, not flagged as timeout.
  const events = runTicks(state, 4 * TICK_RATE);
  const turn = events.find((e) => e.type === 'turn');
  assert.ok(turn, 'turn advanced after wall resolved');
  assert.equal(turn.seat, 1);
  assert.equal(turn.passed, false);
  assert.ok(events.some((e) => e.type === 'capture' && e.who === 0));
});

test('duel: 30s shot clock passes the turn', () => {
  const state = createGame({ mode: 'duel', seed: 6, seats: [{ seat: 0 }, { seat: 1 }] });
  parkAtoms(state, 2.5, 2.5);
  assert.equal(state.turn.ticksLeft, 30 * TICK_RATE);
  const events = runTicks(state, 30 * TICK_RATE + 2);
  const turn = events.find((e) => e.type === 'turn');
  assert.ok(turn, 'timeout passed the turn');
  assert.equal(turn.seat, 1);
  assert.equal(turn.passed, true);
  // And it cycles back to seat 0 after another 30 s.
  const events2 = runTicks(state, 30 * TICK_RATE + 2);
  assert.equal(events2.find((e) => e.type === 'turn')?.seat, 0);
});

test('duel: shattered wall still ends the turn', () => {
  const state = createGame({ mode: 'duel', seed: 7, seats: [{ seat: 0 }, { seat: 1 }] });
  parkAtoms(state, 24.5, 10.5); // dead ahead of the upward head
  assert.ok(tryBuild(state, 0, 24, 20, 'v').ok);
  const events = runTicks(state, 4 * TICK_RATE);
  assert.ok(events.some((e) => e.type === 'shatter'));
  const turn = events.find((e) => e.type === 'turn');
  assert.ok(turn, 'turn advanced after shatter');
  assert.equal(turn.seat, 1);
});

test('duel: match ends at 75% fill with turf scores', () => {
  const state = createGame({ mode: 'duel', seed: 8, seats: [{ seat: 0 }, { seat: 1 }] });
  parkAtoms(state, 2.5, 2.5);
  assert.ok(tryBuild(state, 0, 10, 15, 'v').ok); // captures ~77% for seat 0
  const events = runTicks(state, 4 * TICK_RATE);
  const end = events.find((e) => e.type === 'end');
  assert.ok(end, 'match ended');
  assert.equal(end.result, 'filled');
  assert.ok(end.turf[0] > end.turf[1] || end.turf[1] === 0);
  // No further turns once over.
  assert.equal(runTicks(state, 40).length, 0);
});

test('duel: firstSeat picks the opener, invalid falls back', () => {
  const s1 = createGame({ mode: 'duel', seed: 1, seats: [{ seat: 0 }, { seat: 1 }], firstSeat: 1 });
  assert.equal(s1.turn.seat, 1);
  // Opener still rotates from wherever it started.
  parkAtoms(s1, 2.5, 2.5);
  runTicks(s1, 30 * TICK_RATE + 2);
  assert.equal(s1.turn.seat, 0);
  const s2 = createGame({ mode: 'duel', seed: 1, seats: [{ seat: 0 }, { seat: 1 }], firstSeat: 7 });
  assert.equal(s2.turn.seat, 0);
});

test('duel: passTurn skips the current holder', async () => {
  const { passTurn } = await import('../shared/sim.js');
  const state = createGame({ mode: 'duel', seed: 9, seats: [{ seat: 0 }, { seat: 1 }, { seat: 2 }] });
  const events = passTurn(state);
  assert.equal(events[0].type, 'turn');
  assert.equal(events[0].seat, 1);
  assert.equal(state.turn.seat, 1);
});

test('serialize/snapshot shapes are stable', async () => {
  const { serializeBoard, snapshotAtoms } = await import('../shared/sim.js');
  const state = game();
  const board = serializeBoard(state);
  assert.equal(board.grid.length, TOTAL);
  assert.equal(board.mode, 'party');
  const snap = snapshotAtoms(state);
  assert.equal(snap.length, state.atoms.length);
  assert.equal(snap[0].length, 6);
});
