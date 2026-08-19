# JezzBall — Software Design Document

Version 1.0 — 2026-08-19
Status: **authoritative**. Gameplay numbers are starting values and expected to
be tuned in playtests; protocol and architecture changes require updating this
document in the same PR.

---

## 1. Vision

A multiplayer arcade game you can put in front of anyone — a friend on a phone,
a streamer's chat, an office Slack channel — and have them *playing* within five
seconds of clicking a link. The classic JezzBall loop (bisect the arena, trap
the atoms) is already one of the best risk/reward mechanics ever shipped; this
project's job is to make it **social, kinetic, and frictionless**.

### Design pillars

Every feature decision is tested against these four pillars, in order:

1. **Five seconds to fun.** Link → name → playing. No accounts, no downloads,
   no tutorials longer than one animated hint.
2. **The wall click must feel dangerous.** The core thrill is committing to a
   wall while an atom bears down on it. Nothing (latency, UI, camera) may dull
   that moment.
3. **Chaos together.** Multiplayer must create stories — stolen captures,
   heroic last-pixel saves, disastrous double-walls — not just parallel play.
4. **Juice is a feature, not polish.** Feedback (animation, sound, screen
   shake, announcer) is specified and scheduled like any other system.

### Non-goals (v1)

- No accounts, progression, or monetization (dg-accounts integration is a
  post-launch phase).
- No public matchmaking — rooms are private, joined by link/code only.
- No native/mobile-app builds. The web client must simply be excellent on
  mobile browsers.

### A note on the name

"JezzBall" is the working title (and repo name), inherited from the 1992
Microsoft original. Before any public marketing push, pick a shippable name
(candidates: *Wallbreak*, *Atomfence*, *Cordon!*) — a one-line change in
`shared/branding.js` plus the nginx domain.

---

## 2. Game design

### 2.1 Core loop (both modes)

- The arena is a grid of **48 × 30 cells** (each cell rendered at a
  resolution-independent logical size). Atoms are circles of radius 0.4 cells
  moving at constant speed with elastic reflections off borders, filled cells,
  and completed walls.
- A player aims at an empty cell and clicks (or taps) to **build a wall**:
  two wall heads grow outward from that cell along the chosen axis
  (horizontal or vertical, toggled with right-click / Space / on-screen
  button) at **12 cells/second**.
- Each head's cells are **wet** (fragile) until that head reaches a border or
  filled cell, at which point they set **solid**. When *both* heads have set,
  the wall is complete.
- An atom touching a **wet** cell shatters that head: its wet cells vanish
  with a screen shake, and the builder pays the break penalty (mode-specific,
  §2.2/§2.3). Solid cells are permanent.
- When a wall completes, run the **capture check**: flood-fill empty cells
  from every atom's position; any empty cell unreachable by every atom becomes
  **filled** — captured territory. Captured area is credited to the wall's
  builder.
- **Capture % = filled cells ÷ total cells**, shown as a fat progress bar.

The one-click/one-axis/two-heads model is deliberately unchanged from the
classic — it is the pillar-2 mechanic. Everything multiplayer is layered
around it, never on top of it.

### 2.2 Party Op (co-op, 1–4 players) and Solo

- **Solo quick-start:** Party Op scales down to one player. The landing
  page's *Play solo* button skips the lobby entirely (the room auto-starts),
  and the furthest level reached is remembered on-device so later runs can
  start deeper in the ladder (level picker, capped at the best level
  reached). A solo room is still a real room — the `/r/CODE` link keeps
  working, and a friend who opens it spectates, then converts the run to
  co-op at the next level.
- Team clears a **level ladder**. Level N: `2 + N` atoms, target **60%**
  capture, par time for bonus.
- **Shared team lives** (`3 + players`). A shattered wall costs 1 life. Zero
  lives = run over, show run summary + one-click restart.
- **Combo**: two or more regions sealed within 1.5 s of each other (by the
  same or different players) multiply their area score ×2/×3/×4 with an
  announcer callout. This makes *coordinated* walls the optimal strategy —
  chaos-together by design.
- Hazard atoms appear up the ladder (one new type every ~3 levels):
  - **Splitter** — when sealed into captured territory, splits into two
    smaller atoms in the remaining open region (capture it *last*).
  - **Brute** — heavy; the first hit on a wet wall only stuns the head
    (pauses growth 1 s) but the second shatters it.
  - **Wisp** — passes through *wet* walls harmlessly but reflects off solid
    ones; punishes camping, rewards bold early walls.
- **Power-ups** spawn as pickups in open space, collected by sealing them
  into captured territory; they queue on the team bar and any player can
  trigger one (mapped to keys 1–3 / touch buttons):
  - **Freeze** — atoms at 25% speed for 4 s.
  - **Quickset** — next wall's heads set instantly on placement contact
    cell, i.e. wet time halved.
  - **Ghost wall** — next wall cannot be shattered (atoms pass through wet
    cells) but scores no combo.

### 2.3 Turf War (versus, 2–8 players)

- **2:30 rounds**, best-of-3. Captured cells are painted the capturing
  player's color; **most cells when the timer ends wins the round**.
- No lives. Instead, **energy** (100 max, walls cost 25, shattered wall
  refunds nothing and stings for a further 10; regen 10/s). Energy throttles
  wall spam and makes a shattered wall a real tempo loss, not an elimination
  — nobody sits out a party game.
- Capture attribution is simple and uncelebrated: sealed area belongs to
  whoever *completes* the seal. (An announcer "steal" callout for finishing
  a rival's cut shipped in v1 and was removed as too cheesy — do not
  reintroduce it.)
- Atom count scales with players (`4 + 2×players`), so more players means a
  denser, faster arena, not a diluted one.
- Late-round pressure: at 0:30 remaining, all atoms speed up 25% and the
  music doubles time. Comebacks stay possible; leads stay scary.

### 2.3b Duel (turn-based versus, 2–8 players)

- The atoms never stop — only the **building** is turn-gated. On your turn
  you place exactly **one wall** under a **30-second shot clock**; everyone
  else watches the same live arena.
- The clock runs only while you are deciding: once the wall is placed it
  freezes, and the turn ends when the wall **resolves** — both heads set
  (with any capture credited to you) or shattered (your turn was the price).
  Running the clock out passes the turn with nothing built.
- No energy, no lives — one wall per turn is the whole economy.
- **Opener fairness**: the first game's opener is a server-side coin flip
  (announced "🪙 wins the toss!"); every rematch in the same room alternates
  the opener through the seat order. If the previous opener left the room,
  the coin is flipped again.
- Match end: total fill reaches **60%**; most territory wins. Single board,
  no series; one-click rematch from the podium.
- Disconnected players are skipped by the server until they rejoin (their
  seat's 60 s grace still applies to reclaiming it).
- Atom count matches Turf (`4 + 2×players`), all standard type.

### 2.4 Controls

| Action | Desktop | Mobile |
|---|---|---|
| Aim | mouse hover (ghost preview of both heads) | tap — the preview anchors to that cell |
| Build wall | left click | **swipe from the cell** — the wall launches from where the finger went down |
| Toggle axis | right click / Space | the swipe's own direction picks the axis (horizontal swipe ⇒ horizontal wall); ⇕ button / two-finger tap re-orient the preview |
| Power-up | 1/2/3 | touch buttons |
| Emote wheel | hold E | 😀 button |

The ghost preview always shows exactly which cells both heads will claim and
tints red any atom currently on a collision course with the wet phase — the
risk is legible *before* the click (pillar 2).

Browser navigation gestures are captured and canceled: `overscroll-behavior:
none` plus non-passive `preventDefault` on arena touches suppress
back/forward swipes and pull-to-refresh, and a history-trap `popstate`
handler catches anything the browser refuses to cancel (iOS Safari edge
swipes) by immediately restoring the room entry.

### 2.5 Juice specification (scheduled work, not polish)

- Atoms: squash-and-stretch on every bounce, 8-frame motion trail.
- Wall growth: per-cell "thunk" tick; completion plays a bass "clunk" and a
  1-frame arena flash.
- Capture: flood fill animates outward from the wall at ~40 cells/s in the
  capturer's color with confetti particles; big captures (>8% arena) add
  slow-mo for 0.3 s.
- Shatter: wet cells burst into shards, 200 ms screen shake, builder's
  avatar does a wince emote automatically.
- Announcer (text banners + SFX, no voice in v1): combo tiers, "80%!",
  last-10-seconds countdown.
- All effects respect `prefers-reduced-motion`; SFX mutable. (Music and a
  lobby QR code moved to the post-launch backlog — v1 ships procedural SFX
  and copy-link only.)

### 2.6 Social & session flow

Landing shortcuts: *Play solo* (auto-start, §2.2) and *⚔️ Challenge a
friend* — creates a Duel room and lands in the lobby with the share button
pulsing; sharing uses the native share sheet (Web Share API) on phones and
copy-to-clipboard elsewhere. The emote picker is a bottom slide-out drawer
so it never covers the arena.

```
Landing page ──"Play"──▶ creates room ──▶ Lobby (code ABC123, link copied
     │                                     button, mode picker, color/name)
     └─"Join a game"─▶ code entry          │  players ready-up
                                           ▼
https://jezzball.darksgames.app/r/ABC123 ──▶ same lobby, seat claimed
                                           │
                                           ▼
                                    Round(s) ──▶ Podium screen ──▶ Rematch (1 click,
                                                                   same room persists)
                                                       └─▶ 🏠 Main menu: host returns
                                                           the WHOLE room to the lobby
                                                           (also mid-ladder from an
                                                           intermission) to change mode
                                                           without disbanding the group
```

- Identity: name + color hue stored in `localStorage`; a per-room
  `playerToken` allows silent rejoin after a refresh or drop (60 s seat
  grace, then the seat opens).
- Room codes: 6 chars from an unambiguous alphabet (no `0/O/1/I`), \~10⁹
  space, expire 10 min after the last socket leaves.
- Host powers: kick, mode switch, level select (Party Op). Host migration to
  the longest-seated player on host drop.
- Spectators: players joining a full or in-progress room watch live and are
  auto-seated next round. A streamer's whole chat can pile into one link and
  rotate in — this is the intended growth loop.
- Accessibility: colorblind-safe 8-color player palette with distinct
  territory *patterns* (stripes/dots/…), not color alone.

---

## 3. Technical design

### 3.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node ≥ 22, single process | House standard (`darksgame@` systemd template) |
| Server | Express + **Socket.IO 4** | House precedent (demons-dice); rooms, auto-reconnect, fallbacks for hostile networks |
| Simulation | Pure ES-module library in `shared/` | Identical code runs server-side (authoritative) and client-side (prediction); unit-testable with `node --test` |
| Client | Vanilla ES modules + Canvas 2D | No build step, static-served; house style |
| Persistence | None (in-memory rooms) | v1 has no accounts; dg-accounts/stats is post-launch |

JSON message payloads with short field names; snapshots are deltas (§3.4).
Revisit binary encoding only if profiling shows a need — at ≤8 players and
≤64 atoms per room, it will not.

### 3.2 Process architecture

```
nginx (TLS, static public/) ──proxy /socket.io/, /healthz──▶ node server/index.js
                                                              ├─ RoomManager (Map<code, Room>)
                                                              ├─ Room: players, sim, 30 Hz loop
                                                              │    └─ shared/sim.js (pure)
                                                              └─ /healthz, /r/:code → index.html
```

- One `Room` = one fixed-timestep simulation driven by a `setInterval`
  accumulator at **30 Hz**. Rooms with zero sockets pause immediately and are
  destroyed after 10 min.
- The sim is trivial per tick (≤64 circle-vs-AABB reflections + occasional
  flood fill on a 1 440-cell grid); hundreds of concurrent rooms fit in one
  process. The cap is `MAX_ROOMS=500` (config), returning a friendly "server
  full" beyond it.
- `/r/:code` serves the same static `index.html`; the client reads the code
  from the path. nginx passes unknown paths to Node, so no nginx changes are
  needed for deep links.

### 3.3 Authority model

The server is fully authoritative: it owns atom positions, wall state, fill
state, energy/lives, timers, and scoring. Clients send *intents*; the server
validates (bounds, cell empty, energy/lives available, rate ≤ 4 builds/s) and
either applies or rejects.

**Wall prediction** (the pillar-2 latency answer): wall growth is
deterministic from `(cell, axis, startTick)`. On click, the client renders
the wall growing immediately; the server's `wall` acknowledgment carries the
authoritative `startTick`, and the client slides its local growth to match
(≤2 ticks of correction at typical RTT — invisible). A rejection or shatter
snaps the predicted wall out with the standard shatter effect, so even the
failure case reads as gameplay, not lag.

Atoms are **not** predicted; they render interpolated ~100 ms behind server
time between snapshots. Bounce trajectories are straight lines, so
interpolation is exact, and the delay is imperceptible for objects the player
does not control.

### 3.4 Protocol (Socket.IO events)

Client → server:

| Event | Payload | Notes |
|---|---|---|
| `hello` | `{name, hue, roomCode?, playerToken?}` | joins or rejoins; server replies `welcome` |
| `create` | `{mode}` | new room, sender is host |
| `ready` | `{ready}` | lobby ready-up |
| `build` | `{seq, cx, cy, axis}` | wall intent; `seq` echoes in the ack |
| `power` | `{slot}` | Party Op power-up trigger |
| `emote` | `{id}` | rate-limited 1/s |
| `host:*` | `{...}` | kick / mode / level / start / rematch (host only) |

Server → client:

| Event | Payload | Notes |
|---|---|---|
| `welcome` | `{playerToken, room, seat}` | full room state |
| `lobby` | `{players, mode, level}` | any lobby change |
| `start` | `{level, atoms, startAt}` | countdown to synchronized start |
| `snap` | `{t, atoms:[[id,x,y,vx,vy]…]}` | 15 Hz delta snapshot (only moved atoms) |
| `wall` | `{seq, ok, id?, cell?, axis?, startTick?, who}` | ack + broadcast of every build |
| `set` | `{id, head}` | a head set solid |
| `shatter` | `{id, head, cells, who}` | wet head destroyed |
| `capture` | `{cells, who, pct, combo}` | fill result; client animates flood |
| `score` | `{lives?, energy?, turf?, pct}` | authoritative counters |
| `end` | `{result, podium, stats}` | round/run over |

Full state (`welcome`) is also resent on any reconnect — clients must treat it
as truth and rebuild local state from it.

### 3.5 Simulation details (`shared/sim.js`)

- Grid `48×30` of cell states: `EMPTY | WET(head) | SOLID | FILLED(owner)`.
- Atoms: `{x, y, vx, vy}` in cell units; speed constant per atom type;
  integration per tick with swept reflection against the cell grid (an atom
  can never tunnel at these speeds, but the sweep guards hazard "Brute"
  speed-ups).
- Wall growth: on each tick, each live head advances `12/30` cells of
  progress; whole cells become WET as progress crosses them.
- Capture check runs only on wall completion: flood fill (BFS) from each
  atom's cell over EMPTY∪WET; unreached EMPTY cells → FILLED(owner).
  Worst case ~1 440 cells — microseconds.
- Determinism: integer tick counting, no wall-clock in sim logic; the RNG is
  a seeded PRNG (`mulberry32`) so replays/tests are reproducible. `seed` is
  part of `start`.

### 3.6 Failure, abuse, limits

- **Validation**: every intent is bounds- and state-checked; malformed
  payloads disconnect the socket. Names: 16 chars, control chars stripped,
  light profanity filter.
- **Rate limits** per socket: 4 builds/s, 1 emote/s, 5 events/s general
  bucket; excess is dropped silently (never disconnect a laggy phone).
- **Reconnect**: `playerToken` (128-bit random) reclaims a seat for 60 s;
  Socket.IO handles transport retries beneath that.
- **Backpressure**: if a socket's buffered amount exceeds 256 KB, drop it to
  spectator-of-record (stop sending snaps, keep events) until it drains.
- No user-generated content is persisted or shown beyond names/emotes; no
  cookies beyond localStorage; no PII stored server-side.

### 3.7 Deployment (DarksGames production box — read this)

This server is **multi-tenant production**. Constraints that are easy to get
wrong (each has burned this box before):

1. Deploy target is `/srv/darksgames/games/jezzball` via the catalog-game
   stack (`add-game`, runs as `darks`) — **not** `/srv/apps` (a separate
   stack on the same box).
2. The nginx vhost must **never** claim `default_server` — other tenants
   (site-a/site-b) live here.
3. `add-game jezzball.darksgames.app jezzball` allocates the port (next free
   ≥ 3019), writes `.env` (merge-safe, `chmod 600`), generates the vhost,
   gets the certificate, and starts `darksgame@jezzball`.
4. `*.darksgames.app` is a DNS wildcard: stage risky changes on a throwaway
   subdomain (`jezzball-stage.darksgames.app`) with its own cert, verify,
   then tear down. If a dedicated AAAA record is ever added, it must end
   `::1`, not the bare subnet `::` (browsers fail while curl-from-the-box
   still returns 200).
5. `npm run check` (lint + unit + jsdom smoke) must pass on the deployed
   tree before restart — same convention as snerf.
6. GitHub operations run as **root** (root's key is the one authorized as
   `3disturbed`); clone as root and `chown` to `darks`.

### 3.8 Observability

- `/healthz` returns `{ok, rooms, players, uptime}` — nginx-proxied,
  systemd-watchdog friendly.
- One-line JSON logs to stdout (journald): room created/destroyed, player
  join/leave, round end with duration and capture %, errors with room code.
- A `stats` counter object dumped to the log every 5 min: rooms, players,
  snaps/s, event drops. No external telemetry in v1.

---

## 4. Test plan

| Layer | Tool | What |
|---|---|---|
| Sim unit | `node --test` | reflection math, wall growth ticks, shatter rules, flood-fill capture (golden-grid fixtures), combo windows, energy/lives accounting, PRNG determinism (same seed ⇒ identical 10k-tick run) |
| Protocol | `node --test` + socket.io-client | join/rejoin/token reclaim, host migration, validation rejections, rate limiting |
| Client smoke | jsdom script in `npm run check` | page boots, canvas mounts, fake `welcome` renders a frame without throwing |
| Playtest | humans | latency feel at 100–200 ms artificial delay (tc/netem), mobile Safari + Android Chrome, 8-player room |

`npm run check` = lint + sim unit + protocol + client smoke, and is the gate
for every deploy.

---

## 5. Milestones

Detailed, session-sized breakdown lives in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Summary:

- **M0** Scaffold + checks green
- **M1** Sim library complete and unit-tested (playable headless)
- **M2** Server rooms + protocol (two browsers share one arena, ugly)
- **M3** Client feel: prediction, interpolation, lobby, join links (Party Op solo/co-op playable end-to-end)
- **M4** Juice pass per §2.5
- **M5** Turf War + hazards + power-ups
- **M6** Staged deploy → production `jezzball.darksgames.app` + catalog entry
- **M7** Post-launch: dg-accounts stats, leaderboards, name rebrand decision
