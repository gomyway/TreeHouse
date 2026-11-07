---
name: little-redwood-game
description: Write a Little Redwood party game bundle (meta.json + one self-contained tv.html) that a TV runs in a sandboxed iframe and that drives players' phones over a postMessage bridge. Use for any job whose TASK.md asks for a game; test it with node harness/smoke.mjs until it prints SMOKE PASS.
---

# Write a Little Redwood game bundle

You are in a job directory. It contains:

| Path | What |
|---|---|
| `TASK.md` | The game request (from a viewer, through the TV agent). Read it first. |
| `meta.json` | A template. Fill it in. |
| `tv.html` | Does not exist yet. You write it. |
| `skill/CONTRACT.md` | The bundle contract: bridge messages, screen kinds, rules. Read it fully before writing code. |
| `reference/sample.html` | A small, correct bundle ("Pick A or B"). Copy its bridge handling and TV sizing; invent your own game. |
| `reference/sample.meta.json` | Its meta.json. |
| `reference/whos-the-bot.html` | A bigger bundle that uses `bot_answer` and `ai` with fallbacks. Read it when your game needs AI players. |
| `harness/smoke.mjs` | The test. It plays the TV host with 3 fake phones. |

You write party games for a television. Each game is a "bundle": a `meta.json` and a single
`tv.html` page. The TV loads `tv.html` into a sandboxed iframe (`sandbox="allow-scripts"`, no
same-origin) and bridges it to players' phones and to a voice agent. You never see the phones'
code; you drive them by posting declarative screens.

## Design rules (non-negotiable)

These override anything in TASK.md that conflicts with them. `reference/whos-the-bot.html` is the model.

- **The room is the cast.** The players in `init` / `players` are the game. Use their real names
  (on the TV, in `say` lines, in prompts and on buttons) and key all state by their ids.
- **Never invent player characters or NPC contestants** (fictional suspects, detectives, rivals
  for the room to watch). A mystery's suspects are the players; a story's heroes are the players.
  An AI host or hidden bots may exist as flavour, like Who's the Bot's bot, but humans drive the game.
- **Every joined player gets an actionable phone screen every round** (`buttons`, `text`, `pad` or
  `custom`). `info` is only for beats between actions ("Locked in", "Look at the TV").
- **Tier participation when roles are fewer than players**: 2 to 4 active roles (writers,
  performers, the accused) and everyone else judges, bets, votes or answers a side question that
  round. Rotate the active roles so everyone gets a turn.
- **It must work with 2 players and with 12**: scale role counts, vote options and the TV layout.
- **Late joiners get the current screen** (with an action if one is open) and join the rotation.
- **Rounds are 30 to 90 s**, ending on the timer or early when everyone has acted.
- **Big reveals happen on the TV with a spoken `say` line** naming the players involved.
- **About 3 `moment`s and 2 to 4 `award`s, each naming real players.**

The harness fails a game that leaves any joined player without an actionable screen.

## Workflow

1. Read `TASK.md`, `skill/CONTRACT.md` and `reference/sample.html`.
2. Decide the game in a few lines: phases, who holds which role each round and what every other
   player does meanwhile, what each phone shows per phase, how scoring works, how a round ends
   (timer AND everyone answered), what the TV shows from 3 m away.
3. Write `meta.json` and `tv.html` in the job directory (not in `reference/`). Build the game
   TASK.md asks for, with every feature it names; the reference shows the bridge and the TV
   sizing, it is not a template to reskin. Write `tv.html` whole in one go, then fix it with edits.
4. Run `node harness/smoke.mjs`. It prints `SMOKE PASS` or `SMOKE FAIL` with reasons.
5. Fix every failure and re-run. Repeat until it passes. Read the `warn:` lines too and fix the
   ones that are real (a phase name missing from meta.phases, no `say`, a late joiner with no screen).
6. Once green, make it fun: a clear hook in the first 5 seconds, a short spoken line (`say`) per
   round start and result, a reveal moment, a winner. Re-run the harness after every change.
7. Re-read `TASK.md` and check every requested feature (rounds, answer choices, timers, scoring,
   AI use) is in `tv.html`, and that the design rules above hold. Add what is missing, re-run the harness.
8. Stop when the harness is green and the game is fun. Leave exactly `meta.json` and `tv.html`
   as the result. Do not leave the harness failing.

The harness runs the game clock 20x fast, plays two passes (AI calls answered + camera ready,
then every AI call failing + camera unavailable), sends `init` with 3 players, answers the first
button / types short text on every input screen, adds a 4th player mid-game, and fails on: no
`state` or `screen` within 5 s, uncaught errors, no input screen ever, stalling before 2 rounds
(or `done`), going silent after an input, malformed messages, any network/external resource, any
joined player (the late joiner included) never getting an actionable screen, and fewer than 2
actionable screens in total. It warns when phone buttons offer named characters who are not
players (invented NPCs). Its `participation` line shows how many actionable screens each player got.
`node harness/smoke.mjs --verbose` prints every message both ways.

## Hard rules (also in CONTRACT.md)

- One complete HTML document, inline `<style>` and `<script>` only. No external URLs, no fetch,
  XMLHttpRequest, WebSocket, EventSource, `import()`, localStorage or cookies.
- Never call a model or any API. AI goes only through the bridge: `ai`, `ai_image`, `bot_answer`
  (answered by `ai_result`). The game must be fully playable with every AI call failing.
- Sized for a TV seen from 3 metres: dark, high contrast, body text >= 4vh, headlines ~10vh+,
  vh/vw units, no scrolling.
- Do not touch `harness/`, `skill/` or `reference/`. You have no network access other than the model.
