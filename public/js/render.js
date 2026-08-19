// Canvas renderer + effects. Reads (never writes) the shared game state from
// main.js; all timing runs off the estimated server tick so wall growth and
// atom interpolation stay glued to the authoritative sim.
import { W, H, CELL, TICK_RATE, WALL_SPEED } from '/shared/sim.js?v=9';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const INTERP_TICKS = 3; // ~100 ms behind server
const POWER_ICON = { freeze: '🧊', quickset: '⚡', ghost: '👻' };

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.particles = [];
    this.reveals = new Map(); // cellIndex -> revealAtMs
    this.shakeAmt = 0;
    this.trails = new Map(); // atom id -> [{x, y}]
    this.squash = new Map(); // atom id -> {axis, until}
    this.lastVel = new Map(); // atom id -> {vx, vy}
    this.cell = 20;
    this.raf = null;
    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
  }

  hue(seat) {
    const p = this.game.players.find((x) => x.seat === seat);
    return p ? p.hue : 0;
  }

  reset() {
    this.particles = [];
    this.reveals.clear();
    this.trails.clear();
    this.squash.clear();
    this.lastVel.clear();
    this.shakeAmt = 0;
    this.resize();
  }

  resize() {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const availW = wrap.clientWidth - 8;
    const availH = wrap.clientHeight - 8;
    this.cell = Math.max(6, Math.floor(Math.min(availW / W, availH / H)));
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.style.width = `${this.cell * W}px`;
    this.canvas.style.height = `${this.cell * H}px`;
    this.canvas.width = this.cell * W * dpr;
    this.canvas.height = this.cell * H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start() {
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  // ----- effect triggers (called from main.js on socket events) -----
  capture(cells, seat, combo) {
    const now = performance.now();
    // Reveal outward from the region centroid — the flood-fill "pour".
    let sx = 0;
    let sy = 0;
    for (const ci of cells) {
      sx += ci % W;
      sy += (ci / W) | 0;
    }
    const cx = sx / cells.length;
    const cy = sy / cells.length;
    let maxD = 1;
    const dists = cells.map((ci) => {
      const d = Math.hypot((ci % W) - cx, (((ci / W) | 0)) - cy);
      maxD = Math.max(maxD, d);
      return d;
    });
    const dur = REDUCED ? 0 : Math.min(650, 150 + cells.length * 0.5);
    cells.forEach((ci, i) => this.reveals.set(ci, now + (dists[i] / maxD) * dur));
    if (!REDUCED) {
      const n = Math.min(60, 10 + cells.length / 8) * (combo >= 2 ? 2 : 1);
      for (let i = 0; i < n; i++) {
        this.particles.push({
          x: (cx + (Math.random() - 0.5) * 4) * this.cell,
          y: (cy + (Math.random() - 0.5) * 4) * this.cell,
          vx: (Math.random() - 0.5) * 220,
          vy: -Math.random() * 260 - 40,
          life: 1,
          color: `hsl(${this.hue(seat)} 85% 65%)`,
          size: 2 + Math.random() * 3,
        });
      }
    }
  }

  shatter(cells) {
    if (!REDUCED) this.shakeAmt = Math.max(this.shakeAmt, 7);
    for (const ci of cells) {
      for (let i = 0; i < 3; i++) {
        this.particles.push({
          x: ((ci % W) + 0.5) * this.cell,
          y: (((ci / W) | 0) + 0.5) * this.cell,
          vx: (Math.random() - 0.5) * 300,
          vy: (Math.random() - 0.5) * 300,
          life: 0.7,
          color: '#cfd6ff',
          size: 1.5 + Math.random() * 2.5,
        });
      }
    }
  }

  burst(x, y, color) {
    for (let i = 0; i < 26; i++) {
      this.particles.push({
        x: x * this.cell,
        y: y * this.cell,
        vx: (Math.random() - 0.5) * 320,
        vy: (Math.random() - 0.5) * 320,
        life: 0.9,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }

  fizzle(cx, cy) {
    this.burst(cx + 0.5, cy + 0.5, '#667');
  }

  emote(seat, emoji, name) {
    const wrap = this.canvas.parentElement;
    const el = document.createElement('div');
    el.className = 'float-emote';
    el.innerHTML = `${emoji}<small>${name}</small>`;
    el.style.left = `${15 + Math.random() * 70}%`;
    el.style.top = `${20 + Math.random() * 40}%`;
    wrap.append(el);
    setTimeout(() => el.remove(), 1700);
  }

  // ----- interpolation -----
  serverTickNow() {
    const g = this.game;
    if (g.tickOffsetMs === null) return g.latestTick;
    return (performance.now() - g.tickOffsetMs) / (1000 / TICK_RATE);
  }

  atomPos(a, renderTick) {
    const snaps = a.snaps;
    if (!snaps.length) return null;
    let lo = snaps[0];
    let hi = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= renderTick) {
        lo = snaps[i];
        hi = snaps[i + 1] || null;
        break;
      }
    }
    if (!hi) {
      // Extrapolate (capped) along current velocity.
      const dt = Math.min(renderTick - lo.t, 6) / TICK_RATE;
      return { x: lo.x + lo.vx * dt, y: lo.y + lo.vy * dt, vx: lo.vx, vy: lo.vy };
    }
    const span = hi.t - lo.t || 1;
    const f = Math.max(0, Math.min(1, (renderTick - lo.t) / span));
    return {
      x: lo.x + (hi.x - lo.x) * f,
      y: lo.y + (hi.y - lo.y) * f,
      vx: hi.vx,
      vy: hi.vy,
    };
  }

  // Predicted wet cells for a growing wall at the current tick.
  wallWetCells(wall, tickNow) {
    const out = [[], []];
    const g = this.game;
    const prog = Math.max(0, (tickNow - wall.startTick) * (WALL_SPEED / TICK_RATE) * (wall.quickset ? 2 : 1));
    for (const dirIdx of [0, 1]) {
      const head = wall.heads[dirIdx];
      if (head.done) continue; // set or shattered — authoritative cells drawn from grid
      const dir = dirIdx === 0 ? -1 : 1;
      const count = Math.floor(prog) + (dirIdx === 0 ? 1 : 0); // head 0 owns the seed cell
      for (let n = dirIdx === 0 ? 0 : 1; n < (dirIdx === 0 ? count : count + 1); n++) {
        const cx = wall.axis === 'h' ? wall.cx + dir * n : wall.cx;
        const cy = wall.axis === 'v' ? wall.cy + dir * n : wall.cy;
        if (cx < 0 || cx >= W || cy < 0 || cy >= H) break;
        const c = g.grid[cy * W + cx];
        if (c === CELL.SOLID || c === CELL.FILLED) break;
        out[dirIdx].push([cx, cy]);
      }
    }
    return out;
  }

  aimPreview(tickNow) {
    const g = this.game;
    if (!g.aim || g.over) return null;
    // Duel: no preview while it isn't your turn — the arena reads as locked.
    if (g.mode === 'duel' && (!g.turn || g.turn.seat !== g.seat)) return null;
    const { cx, cy } = g.aim;
    if (cx < 0 || cx >= W || cy < 0 || cy >= H) return null;
    if (g.grid[cy * W + cx] !== CELL.EMPTY) return null;
    const cells = [];
    for (const dir of [-1, 1]) {
      for (let n = dir === -1 ? 0 : 1; ; n++) {
        const x = g.axis === 'h' ? cx + dir * n : cx;
        const y = g.axis === 'v' ? cy + dir * n : cy;
        if (x < 0 || x >= W || y < 0 || y >= H) break;
        const c = g.grid[y * W + x];
        if (c === CELL.SOLID || c === CELL.FILLED) break;
        cells.push([x, y]);
      }
    }
    // Danger tint: any atom heading across the preview line within ~1.2 s.
    let danger = false;
    const cellSet = new Set(cells.map(([x, y]) => y * W + x));
    for (const a of g.atoms.values()) {
      const p = this.atomPos(a, tickNow - INTERP_TICKS);
      if (!p) continue;
      for (let t = 0; t < 1.2; t += 0.1) {
        const x = Math.floor(p.x + p.vx * t);
        const y = Math.floor(p.y + p.vy * t);
        if (cellSet.has(y * W + x)) {
          danger = true;
          break;
        }
      }
      if (danger) break;
    }
    return { cells, danger };
  }

  // ----- main draw -----
  draw() {
    const g = this.game;
    const ctx = this.ctx;
    const c = this.cell;
    const now = performance.now();
    const tickNow = this.serverTickNow();
    const renderTick = tickNow - INTERP_TICKS;

    ctx.save();
    ctx.clearRect(0, 0, W * c, H * c);
    if (this.shakeAmt > 0.3) {
      ctx.translate((Math.random() - 0.5) * this.shakeAmt, (Math.random() - 0.5) * this.shakeAmt);
      this.shakeAmt *= 0.88;
    }

    // Grid dots.
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    for (let y = 1; y < H; y++)
      for (let x = 1; x < W; x++) ctx.fillRect(x * c - 0.5, y * c - 0.5, 1, 1);

    // Board cells.
    for (let ci = 0; ci < W * H; ci++) {
      const v = g.grid[ci];
      if (v === CELL.EMPTY) continue;
      const revealAt = this.reveals.get(ci);
      if (revealAt !== undefined && now < revealAt) continue; // not poured yet
      const x = (ci % W) * c;
      const y = ((ci / W) | 0) * c;
      if (v === CELL.FILLED) {
        const seat = g.owner[ci] - 1;
        ctx.fillStyle = `hsl(${this.hue(seat)} 60% 26%)`;
        ctx.fillRect(x, y, c, c);
        ctx.fillStyle = `hsl(${this.hue(seat)} 70% 34%)`;
        ctx.fillRect(x + 1, y + 1, c - 2, c - 2);
      } else if (v === CELL.SOLID) {
        const seat = g.owner[ci] - 1;
        ctx.fillStyle = `hsl(${this.hue(seat)} 30% 62%)`;
        ctx.fillRect(x, y, c, c);
        ctx.fillStyle = 'rgba(255,255,255,.25)';
        ctx.fillRect(x, y, c, 2);
      }
    }

    // Growing walls (authoritative + predicted), drawn as wet cells.
    const drawWet = (wall) => {
      const wet = this.wallWetCells(wall, tickNow);
      for (const dirIdx of [0, 1]) {
        for (const [x, y] of wet[dirIdx]) {
          const pulse = 0.55 + 0.25 * Math.sin(now / 90 + x + y);
          ctx.fillStyle = wall.ghost
            ? `rgba(190,160,255,${pulse * 0.7})`
            : `hsla(${this.hue(wall.who)} 85% 65% / ${pulse})`;
          ctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
        }
      }
    };
    for (const wall of g.walls.values()) drawWet(wall);
    for (const wall of g.pendingWalls.values()) drawWet(wall);

    // Aim preview.
    const preview = this.aimPreview(tickNow);
    if (preview) {
      ctx.fillStyle = preview.danger ? 'rgba(255,80,80,.30)' : 'rgba(255,255,255,.16)';
      for (const [x, y] of preview.cells) ctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
    }

    // Power-up pickups.
    ctx.font = `${c * 1.1}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const pu of g.powerups) {
      const bob = REDUCED ? 0 : Math.sin(now / 300 + pu.id) * c * 0.12;
      ctx.fillText(POWER_ICON[pu.kind] || '❔', (pu.cx + 0.5) * c, (pu.cy + 0.5) * c + bob);
    }

    // Atoms: trails, squash-and-stretch, type looks.
    for (const [id, a] of g.atoms) {
      const p = this.atomPos(a, renderTick);
      if (!p) continue;
      // Bounce detection for squash.
      const lv = this.lastVel.get(id);
      if (lv && !REDUCED) {
        if (Math.sign(lv.vx) !== Math.sign(p.vx) && p.vx !== 0) this.squash.set(id, { axis: 'x', until: now + 140 });
        else if (Math.sign(lv.vy) !== Math.sign(p.vy) && p.vy !== 0) this.squash.set(id, { axis: 'y', until: now + 140 });
      }
      this.lastVel.set(id, { vx: p.vx, vy: p.vy });

      let trail = this.trails.get(id);
      if (!trail) {
        trail = [];
        this.trails.set(id, trail);
      }
      trail.push({ x: p.x, y: p.y });
      if (trail.length > 8) trail.shift();
      const r = (a.type === 'brute' ? 0.55 : a.type === 'splitter' ? 0.45 : a.type === 'mini' ? 0.3 : a.type === 'wisp' ? 0.35 : 0.4) * c;
      const color =
        a.type === 'splitter' ? '#ff5dcb' : a.type === 'brute' ? '#ffb03a' : a.type === 'wisp' ? '#9fe8ff' : '#ff6b6b';
      if (!REDUCED) {
        trail.forEach((tp, i) => {
          ctx.globalAlpha = (i / trail.length) * 0.25;
          ctx.beginPath();
          ctx.arc(tp.x * c, tp.y * c, r * (i / trail.length), 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        });
        ctx.globalAlpha = 1;
      }
      let sx = 1;
      let sy = 1;
      const sq = this.squash.get(id);
      if (sq && now < sq.until) {
        const k = 0.35 * ((sq.until - now) / 140);
        if (sq.axis === 'x') {
          sx = 1 - k;
          sy = 1 + k;
        } else {
          sx = 1 + k;
          sy = 1 - k;
        }
      }
      ctx.save();
      ctx.translate(p.x * c, p.y * c);
      ctx.scale(sx, sy);
      ctx.globalAlpha = a.type === 'wisp' ? 0.65 : 1;
      const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.15, 0, 0, r);
      grad.addColorStop(0, '#fff');
      grad.addColorStop(0.25, color);
      grad.addColorStop(1, `color-mix(in srgb, ${color} 55%, #000)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Particles.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= 0.016;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * 0.016;
      p.y += p.vy * 0.016;
      p.vy += 420 * 0.016;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Reveal front sparkle.
    if (!REDUCED) {
      for (const [ci, at] of this.reveals) {
        if (now >= at && now < at + 90) {
          const x = (ci % W) * c;
          const y = ((ci / W) | 0) * c;
          ctx.fillStyle = 'rgba(255,255,255,.5)';
          ctx.fillRect(x, y, c, c);
        } else if (now > at + 400) {
          this.reveals.delete(ci);
        }
      }
    } else {
      this.reveals.clear();
    }

    ctx.restore();
  }
}
