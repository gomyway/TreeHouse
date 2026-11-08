---
name: treehouse-game
description: Write a Treehouse party game bundle (meta.json + one self-contained tv.html + its lobby card lobby.html) that a TV runs in a sandboxed iframe and that drives players' phones over a postMessage bridge. Use for any job whose TASK.md asks for a game; test it with node harness/smoke.mjs until it prints SMOKE PASS.
---

# Write a Treehouse game bundle

You are in a job directory. It contains:

| Path | What |
|---|---|
| `TASK.md` | The game request (from a viewer, through the TV agent). Read it first. |
| `meta.json` | A template. Fill it in. |
| `tv.html` | Does not exist yet. You write it. |
| `lobby.html` | Does not exist yet. You write it: the game's lobby card (see "Lobby card"). |
| `skill/CONTRACT.md` | The bundle contract: bridge messages, screen kinds, rules. Read it fully before writing code. |
| `reference/sample.html` | A small, correct bundle ("Pick A or B"). Copy its bridge handling and TV sizing; invent your own game. |
| `reference/sample.meta.json` | Its meta.json. |
| `reference/sample.lobby.html` | Its lobby card: title treatment, backdrop, seats, join block, status line, idle motion. Copy its bridge handling and sizing; draw your own art. |
| `reference/whos-the-bot.html` | A bigger bundle that uses `bot_answer` and `ai` with fallbacks. Read it when your game needs AI players. |
| `harness/smoke.mjs` | The test. It plays the TV host with 3 fake phones. |

You write party games for a television. Each game is a "bundle": a `meta.json`, a single
`tv.html` page and a `lobby.html` card. The TV loads `tv.html` into a sandboxed iframe (`sandbox="allow-scripts"`, no
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
- **It must work with 2 players and with 16** (the most a game takes; `maxPlayers` is at most 16):
  scale role counts, vote options and the TV layout.
- **Late joiners get the current screen** (with an action if one is open) and join the rotation.
- **Rounds are 30 to 90 s**, ending on the timer or early when everyone has acted.
- **Big reveals happen on the TV with a spoken `say` line** naming the players involved.
- **About 3 `moment`s and 2 to 4 `award`s, each naming real players.**

The harness fails a game that leaves any joined player without an actionable screen.

## Look and voice rules (non-negotiable)

These set how the TV page looks and how the host talks. The harness checks them and prints a `look` line.

- **One palette, picked for the theme.** Choose ONE of the six below, write its name in
  `meta.palette`, define its four tokens at `:root` and colour everything with them, plus pure
  black or white for shadows. One accent only.

  | Palette | `--bg` | `--ink` | `--muted` | `--accent` | Mood |
- The TV host may inject a base stylesheet first (Satoshi @font-face, the palette as --bg/--ink/--muted/--accent, --surface, --font, --display/--body/--tiny in vh, a :focus-visible ring). Reference those variables; define them yourself at :root as well, since the bundle must also work without the host. --surface is one step off --bg (6-8% lighter on dark palettes, darker on Paper); --font is "Satoshi", system-ui, sans-serif.
  |---|---|---|---|---|---|
  | Noir | `#0e0e10` ink-black | `#e8e0cf` bone | `#6e7480` slate | `#e5322d` signal red | crime, bluffing, accusations, tension |
  | Broadcast | `#0b1630` deep navy | `#ffffff` white | `#8b97ab` steel | `#ffb000` amber | quiz show, trivia, a live studio |
  | Paper | `#f2ece0` warm off-white | `#16161a` near-black | `#77736b` grey | `#2747d6` cobalt | words, drawing, calm daytime (the light theme) |
  | Arcade | `#08090b` near-black | `#ffffff` white | `#7c8088` grey | `#00e5ff` electric cyan | reflexes, speed, motion, retro |
  | Campfire | `#22170f` dark umber | `#f5ead6` cream | `#b08a4a` ochre | `#ff6a1f` ember orange | stories, confessions, a cosy night |
  | Lagoon | `#08343a` deep teal | `#efe2c4` sand | `#7f9a9c` sea-grey | `#ff6f5e` coral | holidays, silliness, light-hearted |

- **Forbidden:** the purple/lavender/yellow/mint default family (`#b98cff`, `#f6f3ff`, `#ffd23f`,
  `#3ddc84`, `#5fe0c0` and near neighbours), rainbow gradients, more than one accent.
- **Corners:** border-radius 0 to 1.2vh. Never pills (`99px`, `999px`); the countdown ring is the
  only round thing.
- **Three text sizes in the whole page**, each defined once at `:root` and used everywhere:
  `--display` (≥10vh), `--body` (≥4vh), `--tiny` (≥2.4vh). Every `font-size` is one of the three.
- **No bold.** No `font-weight` above 500 anywhere, headings included (`h1`, `b` and `strong` are bold
  by default: set them to 500). Hierarchy comes from size, capitals and colour.
- **One header per screen**, never an eyebrow label stacked on it (no small "ROUND 2" line above the
  headline); put the round count below or in a corner.
- **Font:** `font-family: "Satoshi", system-ui, sans-serif`. The host may inject Satoshi; the
  fallback is fine.
- **No emoji as UI.** Emoji may appear only inside player-typed content echoed back. None in static
  markup, CSS, buttons, headers, phone screens or `say` lines. Draw shapes with text characters
  (● ▲ ★ ✓ ×) or inline SVG.
- **Voice cadence.** `say` lines are 12 words or fewer (player names not counted), one per beat,
  at most one exclamation mark per line, no stacked punctuation (`!!`, `?!`). The TV shows the
  gist; the host says the rest.

The harness fails a forbidden purple-family colour, any `font-weight` of 600 or more, more than 2
emoji anywhere in tv.html, a `say` line over 12 words and an unknown `meta.palette`. It warns on more
than 6 non-grey colours, more than 3 font sizes, pill radii, a missing `meta.palette` and 2 or more
exclamation marks in one line.

### Roster seats

The room stays on screen the whole game, drawn in the game's own world.

- **A seat per player on every screen.** Every TV screen state keeps a row of player seats: one
  element per joined player with `data-player="<id>"` and `data-state="thinking"`, `"answered"` or
  `"out"`. Each seat shows the player's name in `--tiny` and a playful icon from the game's world.
  The strip must fit 16 seats across 1920 px: abbreviate names above 10 characters (9 letters and "…").
- **Icons from the game's world.** Draw 6 to 12 inline-SVG variants for this game (a heist crew:
  masks, crowbars, torches; a courtroom: gavels, wigs, scales; a cooking show: hats, whisks, pans).
  Single colour with `currentColor` so the palette drives them, `viewBox="0 0 48 48"`, one or two
  simple paths, no text inside the SVG, no emoji. Each icon is self-contained (the host draws it as
  an `<img>` data: URL with `currentColor` baked to the player's colour): an `<svg>` root, fill and
  stroke as attributes on the elements, no `<script>`, no `<style>` or classes that need page CSS, no
  external `href` or `url()`.
- **Stable assignment.** Assign a variant per player at `init`: index by player order, stable for
  the whole game (late joiners take the next one). When the init players carry a `guid`, derive the
  index from the guid so the same person keeps their icon across games: FNV-1a 32-bit of the guid,
  modulo the seat count, the hash the TV lobby uses, so the lobby and the game agree.
- **Visible state.** thinking = outlined icon, answered = filled icon in the accent, out = 40%
  opacity, the leader gets a ★ glyph after the name.
- **Scores count up in place** on the seat (over about 600 ms) when points are awarded.
- **The phone header may reuse the icon:** send it in the player's first screen as `custom` html
  (a seat card with the icon and name; html that never calls `postMessage` is display-only, so it
  is not an action and the harness does not answer it).
- **Export the set** in `meta.json` as `"seats": [{ "name": "<variant name>", "svg": "<svg …>" }]`,
  the same markup tv.html draws, so the host can draw the room in the game's seats from the picker.
  Also write `meta.hook`: one sentence naming the game's world.

The harness fails a pass where fewer than 80% of the distinct TV states (one per distinct `state`
message) show a `data-player` seat for every joined player, a `meta.seats` that is missing, has
fewer than 6 or more than 12 entries, or has an entry without an `<svg>` root, a `viewBox` and
`currentColor` (or with a `<text>` element, an emoji, a `<script>` or an external reference), and a player who answered on their phone whose seat never reached
`data-state="answered"`. It warns when no phone screen carries a seat icon and when `meta.hook` is
missing, and prints `seats: <n> variants, <pct>% of states, answered-state ok` in the `look` line.

### Lobby card

Every game ships its own lobby art: `lobby.html` beside `tv.html`, shown in the right pane of the
TV lobby while the room joins (the left pane is the list of games).

- **Self-contained and silent.** One complete HTML document: inline CSS and SVG, and a small inline
  script for the bridge. No network, no external fonts or images, no audio, no `say`, no
  `postMessage` other than `lobby_ready`.
- **Laid out in the iframe's own vw/vh; it never scrolls.** Design for a pane around 1280x1080; it
  must hold from 1100x900 to 1400x1080 (the host owns the exact size).
- **It must contain:**
  1. **A title treatment:** the game's name as art (SVG lettering, layered or stacked type, a
     badge), never a plain `h1`. An SVG title carries `<title>` or `aria-label` with the name.
  2. **A backdrop** in the palette, built from the game's motifs (the seat icons are good material).
  3. **The room as the game's seats:** the same SVG set as `meta.seats`, icon and name, in join
     order; the first player is marked VIP; empty "join" slots up to `maxPlayers` (at most 16), in two
     rows when above 8. Each
     player's seat has `data-player="<id>"`, each empty slot `data-slot="empty"`.
  4. **The join block:** `joinUrl` without its scheme (`play.example/?c=DEMO`) and the room code, both
     large; the code at 14vh or more (so the card's `--display` is at least 14vh).
  5. **The hook line** (`meta.hook`).
  6. **A status line** marked `data-status`, driven by `ready`: "Needs 2 more" (`minPlayers` minus
     players) while `ready` is false, "Everyone in? Say start" when it is true.
  7. **Idle motion:** a CSS `@keyframes` animation that runs continuously (lights sweeping, icons
     bobbing).
- **Look rules apply:** palette tokens, three sizes, no bold, no emoji, no pills.
- **Bridge.** Host → card, on load and on every change:
  `{ type: "lobby", code, joinUrl, players: [{ id, name, guid?, connected }], minPlayers, maxPlayers, ready: boolean, focused: boolean }`.
  Card → host: `{ type: "lobby_ready" }` once, after the first paint (inside `requestAnimationFrame`).
  Nothing else.
- **Seat assignment is the game's own rule:** FNV-1a 32-bit of the guid modulo the seat count,
  else join order, so a player keeps their icon from the lobby into the game.
- **Before the first `lobby` message,** show the title, the backdrop and empty join slots.
- `meta.lobby` is set by the runner when `lobby.html` exists; do not write it yourself.

The harness loads `lobby.html` at 1280x1080, posts a `lobby` message with 4 players (code `DEMO`,
join URL `https://play.example/?c=DEMO`, `minPlayers` 3, `maxPlayers` 8, `ready` true), then one
with 2 players and `ready` false. It fails when `lobby.html` is missing, throws, references anything
outside itself, has an `<audio>` tag, posts anything but `lobby_ready` (or never posts it), lacks a
player's name, the code or `play.example` in its text, has fewer than 4 `data-player` seats or 4
`data-slot="empty"` slots, draws the code under 14vh, has no title treatment, declares no animation,
or keeps the same `data-status` text when `ready` changes. The look checks run on it too and the
`look` line ends with `lobby: ok`; a `lobby card:` line summarises the card.

## Workflow

1. Read `TASK.md`, `skill/CONTRACT.md` and `reference/sample.html`.
2. Decide the game in a few lines: phases, who holds which role each round and what every other
   player does meanwhile, what each phone shows per phase, how scoring works, how a round ends
   (timer AND everyone answered), what the TV shows from 3 m away, which palette fits the theme.
3. Write `meta.json` (with `palette`, `hook` and `seats`) and `tv.html` in the job directory (not in `reference/`), then `lobby.html` (see "Lobby card"). Build the game
   TASK.md asks for, with every feature it names; the reference shows the bridge and the TV
   sizing, it is not a template to reskin. Write `tv.html` whole in one go, then fix it with edits.
4. Run `node harness/smoke.mjs`. It prints `SMOKE PASS` or `SMOKE FAIL` with reasons.
5. Fix every failure and re-run. Repeat until it passes. Read the `warn:` lines too and fix the
   ones that are real (a phase name missing from meta.phases, no `say`, a late joiner with no screen).
6. Once green, make it fun: a clear hook in the first 5 seconds, a short spoken line (`say`, 12 words or fewer) per
   round start and result, a reveal moment, a winner. Re-run the harness after every change.
7. Re-read `TASK.md` and check every requested feature (rounds, answer choices, timers, scoring,
   AI use) is in `tv.html`, and that the design rules above hold. Add what is missing, re-run the harness.
8. Stop when the harness is green and the game is fun. Leave exactly `meta.json`, `tv.html` and
   `lobby.html` as the result. Do not leave the harness failing.

The harness runs the game clock 20x fast, plays two passes (AI calls answered + camera ready,
then every AI call failing + camera unavailable), sends `init` with 3 players, answers the first
button / types short text on every input screen, adds a 4th player mid-game, and fails on: no
`state` or `screen` within 5 s, uncaught errors, no input screen ever, stalling before 2 rounds
(or `done`), going silent after an input, malformed messages, any network/external resource, any
joined player (the late joiner included) never getting an actionable screen, and fewer than 2
actionable screens in total. It warns when phone buttons offer named characters who are not
players (invented NPCs). It also runs the look and voice checks above (palette, colours, weights,
sizes, radii, emoji, `say` length) and the roster seats (a seat per joined player in at least 80%
of TV states, `meta.seats`, the answered state); it prints one static `look` line and one per pass. Its `participation` line
shows how many actionable screens each player got.
`node harness/smoke.mjs --verbose` prints every message both ways.

## Hard rules (also in CONTRACT.md)

- One complete HTML document, inline `<style>` and `<script>` only. No external URLs, no fetch,
  XMLHttpRequest, WebSocket, EventSource, `import()`, localStorage or cookies.
- Never call a model or any API. AI goes only through the bridge: `ai`, `ai_image`, `bot_answer`
  (answered by `ai_result`). The game must be fully playable with every AI call failing.
- Sized for a TV seen from 3 metres: one palette from "Look and voice rules", high contrast, the
  three text sizes (display >= 10vh, body >= 4vh, tiny >= 2.4vh), vh/vw units, no scrolling.
- `lobby.html` is self-contained and silent too: posts only `lobby_ready`, no audio, no `say`.
- Do not touch `harness/`, `skill/` or `reference/`. You have no network access other than the model.
