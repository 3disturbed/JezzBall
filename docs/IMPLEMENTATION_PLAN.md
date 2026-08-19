# JezzBall — Implementation Plan (Claude Code on the DarksGames server)

This plan is written to be executed by **Claude Code running on this server**
(`claude` is installed at `/root/.local/bin/claude`, v2.1+). Each phase is
sized for one focused session, has a paste-ready kickoff prompt, and ends with
verifiable acceptance criteria. Work happens in `/root/JezzBall` (the working
checkout); nothing touches `/srv/darksgames/games/` until Phase 6.

**How to run a phase:**

```bash
cd /root/JezzBall && claude
```

then paste the phase prompt. Between phases: review the diff, run
`npm run check`, commit, push.

---

## Standing guardrails (apply to every session)

These come from hard-won operational history on this box. They are also in
`docs/SDD.md` §3.7 — repeat offenders, so they are repeated here:

- **This machine is production for multiple tenants.** Never write nginx
  config with `default_server`. Never restart services other than
  `darksgame@jezzball`. Stage anything risky on a throwaway
  `*.darksgames.app` subdomain first.
- The SDD (`docs/SDD.md`) is authoritative for gameplay numbers, protocol
  shape, and architecture. If implementation forces a change, edit the SDD in
  the same commit.
- `npm run check` must pass before every commit that claims a phase done.
- GitHub: push as root over SSH (`git@github.com:3disturbed/JezzBall.git`).
- No new runtime dependencies beyond `express` and `socket.io` without a
  written reason in the commit message.

---

## Phase 0 — Scaffold & checks (S)

**Goal:** empty-but-green project skeleton matching the repo layout in
README.md.

- `package.json` (`"type": "module"`, Node ≥22 engines, scripts: `start`,
  `dev`, `check`), `eslint.config.js` (flat config, no style bikeshedding —
  errors only), `.gitignore` (`node_modules`, `.env`, `*.log`).
- Directory stubs: `server/index.js` (Express serving `public/`, `/healthz`),
  `shared/sim.js` (empty exports), `public/index.html` + `public/js/main.js`
  (canvas mounts, renders a placeholder), `test/` with one passing test.
- `npm run check` = `eslint . && node --test && node test/smoke/client.mjs`
  (jsdom smoke, devDependency).

**Accept:** `npm run check` green; `npm start` serves the placeholder page on
`:3000`; committed and pushed.

**Prompt:** *"Read docs/SDD.md §3.1–3.2 and README.md repo layout. Build
Phase 0 of docs/IMPLEMENTATION_PLAN.md exactly — scaffold only, no gameplay.
Finish with npm run check green."*

## Phase 1 — Simulation library (M)

**Goal:** `shared/sim.js` complete per SDD §3.5, pure and deterministic, with
the full unit suite from §4. No networking, no rendering.

- Grid, atoms with swept reflection, wall head growth/set/shatter, capture
  flood fill, combo window accounting, lives (Party Op) and energy (Turf War)
  ledgers, seeded PRNG, atom types (standard + Splitter/Brute/Wisp behind a
  flag), fixed-tick `step(state, intents) → events`.
- Golden-grid fixtures for capture correctness (L-shapes, nested chambers,
  atom-on-the-line edge cases).
- Determinism test: same seed + same intent script ⇒ byte-identical state
  hash after 10 000 ticks.

**Accept:** unit suite ≥ all SDD §4 sim rows; a `test/headless-play.mjs`
script runs a scripted 3-wall level to 75% capture and prints the event log.

**Prompt:** *"Implement Phase 1 per docs/IMPLEMENTATION_PLAN.md and SDD §2.1,
§2.2–2.3 scoring, §3.5. Pure library + tests only. Determinism test is
non-negotiable."*

## Phase 2 — Server: rooms & protocol (M)

**Goal:** authoritative multiplayer per SDD §3.2–3.4, §3.6.

- `RoomManager`, `Room` with 30 Hz accumulator loop, 15 Hz delta snapshots,
  full protocol table from §3.4, validation + rate limits + backpressure from
  §3.6, `playerToken` rejoin, host migration, `/r/:code` route, `/healthz`
  with real counts, JSON logging per §3.8.
- Protocol tests with `socket.io-client` (join/rejoin, rejection paths,
  limits) added to `npm run check`.

**Accept:** two terminal socket.io-client scripts can create/join a room and
complete a scripted Party Op level against the real server; checks green.

**Prompt:** *"Implement Phase 2 per the plan and SDD §3.2–3.4/§3.6/§3.8. The
sim from shared/sim.js is the only game logic — the server orchestrates it.
Add the protocol test suite to npm run check."*

## Phase 3 — Client: playable & networked (L)

**Goal:** the game is *playable and feels right* — SDD §2.4 controls, §3.3
prediction/interpolation, §2.6 flow. Ugly-but-crisp beats pretty-but-mushy.

- Canvas renderer (grid, atoms interpolated 100 ms behind, walls, fill),
  ghost preview with red collision tint, wall prediction with ack
  reconciliation, lobby UI (name/hue, code display, copy-link, QR, ready-up,
  host controls), `/r/:code` deep-link join, rejoin-on-refresh, spectator
  seat flow, mobile touch controls + responsive canvas.
- jsdom smoke extended: fake `welcome`+`snap` renders a frame.

**Accept:** two browsers (one desktop, one phone on LAN) play a full Party Op
co-op level via a shared link; wall click feels instant at 150 ms simulated
RTT (`tc qdisc … netem delay 150ms` on lo, documented in the test notes).

**Prompt:** *"Implement Phase 3 per the plan, SDD §2.4, §2.6, §3.3. Priority
order: wall prediction feel > lobby flow > mobile. Verify the netem latency
test yourself and record results in docs/playtests.md."*

## Phase 4 — Juice pass (M)

**Goal:** SDD §2.5 implemented as specified — every line of it, including
reduced-motion and volume controls. Squash-and-stretch, trails, capture flood
animation + confetti + slow-mo, shatter shake, announcer banners, SFX
(generated/procured small OGGs), music toggle, emote wheel.

**Accept:** side-by-side before/after capture GIF in `docs/`; reduced-motion
verified; no frame drops with 8 players + 40 atoms on a mid phone (measure
with Chrome tracing, note numbers in docs/playtests.md).

## Phase 5 — Turf War, hazards, power-ups (M)

**Goal:** SDD §2.2 hazard atoms + power-ups on the Party Op ladder, and §2.3
Turf War complete (energy, steals + announcer callouts, scaling atom count,
last-30s pressure, best-of-3, podium, one-click rematch).

**Accept:** 3-browser Turf War best-of-3 completes with correct scoring and a
steal callout reproduced in test; ladder reaches level 10 with all three
hazards live; checks green.

## Phase 6 — Deploy (S, follow the runbook exactly)

**Goal:** staged then production deploy on this box, per SDD §3.7.

1. `git clone` (as root) to `/srv/darksgames/games/jezzball`, `npm ci --omit=dev`,
   `chown -R darks:darks`, run `npm run check` **on the deployed tree**.
2. Stage: `add-game jezzball-stage.darksgames.app jezzball` → verify over the
   public internet from a phone (not curl-from-the-box — it lies about
   DNS/TLS problems), including a two-device game.
3. Production: `add-game jezzball.darksgames.app jezzball`, re-verify, then
   tear down the stage vhost/cert.
4. Catalog: add JezzBall to the DarksGamesSite Apps section. **Careful:** the
   Apps catalog work lives on an unmerged branch and worktrees branch from a
   stale `origin/main` — start from local `main`, and diff live vs repo
   before any overwrite-style deploy of the site.
5. `systemctl status darksgame@jezzball`, journald logs clean for 24 h.

**Accept:** `https://jezzball.darksgames.app` playable from two phones off-box;
no other tenant's vhost touched (diff `/etc/nginx/sites-enabled` before/after);
registry.tsv has exactly one new line.

## Phase 7 — Post-launch (backlog, separate sessions)

- dg-accounts (`:3018`, s2s secrets in `/root/dg-backups`) opt-in sign-in:
  stats, win/loss, cosmetic hue unlocks. Email is stubbed and Stripe
  unconfigured in dg-accounts — nothing here may depend on either.
- Public leaderboard (daily capture-speed runs, seeded identically for all).
- Name/brand decision (SDD §1) before any marketing.
- Consider binary snapshots only if `/healthz` stats show bandwidth pain.

---

## Sizing legend

S = one short session · M = one full session · L = may need two; if a phase
exceeds its size, stop, commit what is green, and split the remainder into a
new phase in this file rather than pushing a half-done milestone.
