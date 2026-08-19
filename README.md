# JezzBall

**Carve the arena. Trap the atoms. Bring your friends.**

JezzBall is a fast, juicy, multiplayer remake of the classic wall-building
arcade game. One click creates a lobby; send the link to a friend and they are
in the game in under five seconds — no account, no download, phone or desktop.

Live (planned): **https://jezzball.darksgames.app**

## The game in one paragraph

Atoms ricochet around an arena. You click to grow a wall that splits the space
in two; any region sealed off with no atoms inside gets captured. An atom that
hits a wall while it is still growing shatters it. Capture 60% of the arena to
clear the level — or, in Turf War, capture more than your rivals before the
clock runs out. Simple to learn, absurdly tense in the endgame, and built for
"one more round" with up to 8 players in a room.

## Modes

| Mode | Players | Pitch |
|---|---|---|
| **Solo** | 1 | Instant start from the landing page — no lobby. Level-ladder progression is remembered on your device; start later runs from your best level. |
| **Party Op** (co-op) | 1–4 | Shared arena, shared team lives, escalating levels with hazard atoms and power-ups. Seal regions simultaneously for combo bonuses. |
| **Turf War** (versus) | 2–8 | 2½-minute rounds. Sealed territory is painted in your color; most turf when the timer ends wins. Best-of-3 with one-click rematch. |
| **Duel** (turn-based versus) | 2–8 | One wall per turn on a 30-second shot clock while the atoms keep flying. Arena fills to 60%, most territory wins. |

On phones: tap to aim, then **swipe to launch** — the swipe's direction sets
the wall's orientation.

## Why it feels good

- **Server-authoritative 30 Hz simulation** with client-side wall prediction —
  your wall starts growing the instant you click.
- **Juice everywhere**: squash-and-stretch atoms, capture flood-fill bursts,
  screen shake on wall breaks, combo announcer, emote wheel.
- **Instant social loop**: `Play → share link → friend joins` with a 6-letter
  room code baked into the URL. Reconnect grace if someone drops.
- **Runs anywhere**: vanilla ES-module client, canvas renderer, responsive
  touch controls. No framework, no build step.

## Repo layout

```
docs/SDD.md                   Software Design Document (game + technical design)
docs/IMPLEMENTATION_PLAN.md   Phased build plan, driven by Claude Code on the server
server/                       Node 22 authoritative game server (Express + Socket.IO)
shared/                       Pure simulation library shared by server and client
public/                       Static client (canvas renderer, ES modules)
```

`server/`, `shared/`, and `public/` are created in Phase 0 of the
implementation plan; until then this repo is design docs.

## Development

```bash
npm install
npm run dev      # local server on :3000 with autoreload
npm run check    # lint + unit tests + headless smoke test (required before deploy)
```

## Deployment (DarksGames server)

JezzBall deploys like every other catalog game on the box: the game directory
lives at `/srv/darksgames/games/jezzball`, runs as the `darksgame@jezzball`
systemd unit on a port allocated in `/srv/darksgames/registry.tsv`, with nginx
serving `public/` statically and proxying everything else (including
`/socket.io/`) to the Node process.

```bash
add-game jezzball.darksgames.app jezzball
```

Risky changes are staged first on a throwaway wildcard subdomain
(e.g. `jezzball-stage.darksgames.app`) and torn down after verification. See
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full
phase-by-phase plan and the server-specific guardrails.

## Status

Design phase. The SDD is authoritative for gameplay and protocol decisions;
when code and SDD disagree, update whichever is wrong in the same PR.
