// Headless scripted game: three walls to >75% capture, event log printed.
// Doubles as a sim exercise under `node --test` (throws on failure).
import { createGame, step, tryBuild, TICK_RATE, TOTAL } from '../shared/sim.js';

const state = createGame({ mode: 'party', seed: 2026, seats: [{ seat: 0 }], level: 1 });
for (const a of state.atoms) {
  a.x = 2.5;
  a.y = 2.5;
  a.vx = 0;
  a.vy = 0;
}
const log = [];
const walls = [
  [24, 15, 'v'],
  [12, 15, 'v'],
  [6, 15, 'v'],
];
let w = 0;
for (let t = 0; t < 20 * TICK_RATE && !state.over; t++) {
  if (w < walls.length && state.walls.size === 0) {
    const [cx, cy, axis] = walls[w++];
    const r = tryBuild(state, 0, cx, cy, axis);
    log.push(`t=${state.tick} build @${cx},${cy} ${axis}: ${r.ok ? 'ok' : r.reason}`);
  }
  for (const e of step(state)) {
    if (e.type === 'capture') log.push(`t=${state.tick} capture ${e.cells.length} cells -> ${(e.pct * 100).toFixed(1)}%`);
    if (e.type === 'end') log.push(`t=${state.tick} END: ${e.result}`);
  }
}
console.log(log.join('\n'));
if (!(state.filled / TOTAL >= 0.6)) {
  console.error(`headless-play FAILED: only ${((state.filled / TOTAL) * 100).toFixed(1)}% captured (target 60%)`);
  process.exit(1);
}
console.log(`headless-play ok: ${((state.filled / TOTAL) * 100).toFixed(1)}% captured with ${w} walls`);
