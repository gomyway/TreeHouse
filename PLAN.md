# Shared infra plan (draft, edit freely)

Goal for today: a phone + TV + relay backbone that any living-room idea can sit on.
The **TV is the server**. The relay is a dumb public pipe. Phones join with a short
code, like jackbox.tv.

## Shape

| Piece | Lives in | Role |
|---|---|---|
| TV app | `tv/` (the Little app, moved from the repo root) | Owns all state and game logic. Runs in the TV's browser. Exposes tools so the TV's agent can drive it by voice. |
| Relay | `relay/` (Node + `ws`) | Assigns room codes, forwards frames between the TV socket and the phone sockets, serves the phone shell as static files. No logic. |
| Phone shell | `phone/` (Vite, vanilla or React) | `https://<relay>/` : enter code, then render whatever **screen** the TV sends and stream whatever **sensors** the TV asks for. Phones only ever display what the TV sends, so hidden roles (e.g. which player is a bot) never reach a phone unless a bundle puts them in a screen. |
| Protocol | `shared/protocol.ts` | The message envelopes, imported by all three. |

## Join flow

1. TV app `onEnter` opens `wss://<relay>/host`. Relay answers `{ type: "room", code: "ABCD" }`.
   TV shows the code huge plus a QR to `https://<relay>/?c=ABCD`, with `data-little` readouts
   so the agent can read the code aloud ("the join code is A B C D").
2. Phone opens the relay URL (QR prefills the code), enters a name, shell opens
   `wss://<relay>/join?code=ABCD&name=Ana`. Relay forwards `{ type: "join", player }` to the TV.
   TV answers with that player's first screen.
3. Steady state. Phone to TV: `{ type: "input", player, data }` and `{ type: "sensor", player, kind, data }`.
   TV to phones: `{ type: "screen", to: playerId | "*", screen }` and `{ type: "state", payload }`.
4. Reconnect. The phone keeps its `playerId` in `sessionStorage`; the relay re-attaches it and the
   TV gets `{ type: "rejoin", player }`. If the TV socket drops, the relay holds the room for
   60 s and tells phones "TV reconnecting", then closes it.

## Screens are declarative

The phone shell renders JSON the TV sends, so new phone UIs never need a phone deploy:

- `{ kind: "buttons", items: [{ id, label }] }`
- `{ kind: "text", prompt, maxLength }` (the phone shows a live "n/max" counter)
- `{ kind: "pad" }` (touch joystick / drag area, streams `input` at ~20 Hz)
- `{ kind: "info", title, body }`
- `{ kind: "custom", html }` for anything generated on the fly (sandboxed iframe, postMessage bridge)

Every kind takes an optional `deadline` (epoch ms). The phone shows a big countdown by its own clock
(assumed within ~1 s of the TV's) and at zero disables the inputs and shows "Time's up, look at the TV":
a `text` screen auto-submits what was typed, or sends `{ kind: "text", text: "", late: true }` if nothing
was; a `buttons` screen sends nothing. The TV still closes the round on its own timer (allow ~1.5 s grace).

That last one is what makes "games authored live by an agent" possible later with zero phone work.

## Sensors and outputs (the extension points)

Phone side, each opt-in because the TV sent `{ type: "ask", kind }` and the shell shows a tap
(iOS requires a user gesture for motion and media):

- `gyro`: DeviceOrientation + DeviceMotion, streamed as `sensor` frames at ~30 Hz
- `camera`: `getUserMedia`, downscaled JPEG snaps on demand (cap 256 KB)
- `mic`: level stream, or short clips, or the platform-native path below
- `speak`: TV sends `{ type: "play", text | url }`; shell uses SpeechSynthesis / an `<audio>`

TV side, through the Little SDK capabilities declared in the manifest:

- `media.camera` (host-gated camera track), `sense.pose` (COCO-17 keypoints), `sense.speech` (transcript tap)
- `voice.say` for host narration, `media.liveMic` + `@kabletv/little-phone` to play a phone's mic through the TV speakers
- Tools for the agent: `start`, `next`, `read_code`, `kick`, plus whatever the experience adds

## Hosting

- The relay is a **Cloudflare Worker** (`relay/`): one Durable Object per room, keyed by the 4-letter
  code, holds the TV socket and the phone sockets (WebSocket hibernation API, so idle rooms cost
  nothing). The phone shell is served by the same Worker as static assets, so phones use one URL.
  No laptop, no tunnel. `wrangler dev` runs the identical thing locally for `little dev`.
- The same Worker is where a just-in-time coding-agent endpoint goes later (`/agent/*`, secrets via
  `wrangler secret`), so generated phone screens or whole mini-games can be produced server-side
  without a second deploy target.
- The TV app reads `VITE_RELAY_URL` (local `ws://127.0.0.1:8787` or the deployed `wss://…workers.dev`).
- Codes: 4 letters, no look-alikes, expire with the room (60 s grace after the TV drops, 5 min for a
  phone to rejoin). Frames capped at 256 KB. No other auth; the TV reattaches with a host token.

## Repo layout and tooling

- npm workspaces: `tv/`, `phone/`, `relay/`, `shared/`. Keep npm and the existing lockfile.
- One PR moves the root scaffold into `tv/` (`git mv`); nothing inside it changes.
- Root `npm run dev` runs relay + phone + `little dev` together.
- Commits go straight to `main` (Leo: "merge without approval"); open a PR only when a conflict is likely.

## Build order (a suggestion, swap freely)

1. `shared/protocol.ts`, the relay Worker and the phone shell. (Done 2026-11-07 ~12:10, headless end-to-end test passes locally.)
2. Deploy the relay (`wrangler deploy`, needs a Cloudflare login) and point the phone QR at it.
3. TV: connect, big code + QR, player list, readouts and tools. ~1 h
4. End-to-end loop: TV asks every phone a question and shows the answers. Proves the pipe.
5. Sensors: gyro first (cheapest, most visible), then camera snap, then mic.
6. `little publish`.

## Open questions for Leo's side

- Relay and phone shell are in; the TV piece (connect, big code + QR, player list, readouts, tools) is the next open slot. Want it, or should I keep going?
- OK to move the root scaffold into `tv/`?
- Do we want the relay to tunnel HTTP to the TV (TV serves phone pages itself)? I'd defer: declarative screens cover it with less plumbing.
- What is the experience you were leaning toward? The backbone is idea-agnostic, but the first sensor to wire depends on it.

## The loop (Nelson's whiteboard, 2026-11-07 12:18)

0. **Authoring.** Someone describes a game to the TV by voice ("a two-phase quiz where…"). The TV's
   agent calls the `author` tool with the description. The authoring manager (Claude behind a Worker
   endpoint) writes a **game bundle** and stores it.
1. **Pull game.** The TV fetches the bundle by id (or the latest) from game storage.
2. **Join.** Lobby, code, QR, phones (built).
3. **Play.** The TV runs the bundle; the bundle drives the phones through the existing screen/input
   protocol. The agent narrates from the bundle's state summary.
4. Back to 0, or home.

## Three public addresses (one Worker, three route families; split later if needed)

| Address | Role | Owner |
|---|---|---|
| `wss://<worker>/host`, `/join`, `/rooms/:code` | Relay (done) | Nelson's side |
| `POST /author` `{ prompt, context? }` → 202 `{ jobId, status }`; poll `GET /author/:jobId` (every 2 s, give up at 4 min) until `done` with `{ id, meta }`; `POST /author?wait=1` → `{ id, meta }` inline | Authoring manager. Calls a coding model on Fireworks with the bundle contract below (job runs in a Durable Object alarm, state in R2 `jobs/<jobId>.json`, see relay/README.md); secret `FIREWORKS_API_KEY` via `wrangler secret`, model in `AUTHOR_MODEL`. `AUTHOR_FAKE=1` returns a canned bundle for tests. | Nelson's side |
| `GET /games`, `GET /games/:id/meta.json`, `GET /games/:id/tv.html` | Game storage (R2 bucket `GAMES`; only `/author` writes). A hand-written sample bundle is seeded so the TV can pull before authoring works. | Nelson's side |
| Game runner in `tv/` | Loads `tv.html` into a sandboxed iframe and bridges it to the relay + the Little agent | Leo's side |

## Game bundle

- `meta.json`: `{ id, title, description, phases: string[], minPlayers, maxPlayers, createdAt, prompt, phonesRequired? }` (`phonesRequired: false` for camera-only games that start with nobody joined; phones stay optional for names and bets)
  - `palette`, `hook` (one sentence naming the game's world) and `seats` (`[{ name, svg }]`, 6 to 12 self-contained 48×48 currentColor icons the game draws its roster seats with; the TV lobby draws the room in them). Rules: relay/runner/skill/SKILL.md "Roster seats".
- `tv.html`: one self-contained page (inline CSS/JS, no network) the TV loads in a sandboxed
  iframe (`allow-scripts`). It never touches the relay; it talks to the TV host over `postMessage`:

  host → game
  - `{ type: "init", players: Player[], code }`
  - `{ type: "players", players: Player[] }` on join / leave
  - `{ type: "input", player, data }` and `{ type: "sensor", player, kind, data }` as they arrive
  - `{ type: "voice", text }` when the agent relays a viewer instruction to the game (optional)
  - `{ type: "ai_result", id, ok, data?, url?, error? }` answering an `ai` / `ai_image` / `bot_answer` request (below)

  game → host
  - `{ type: "screen", to, screen }`, `{ type: "ask", to, kind, on, hz }`, `{ type: "play", to, text|url }` (forwarded to the relay as-is)
  - `{ type: "say", text, id?, interrupt? }` (the host speaks it; with an `id`, the host answers `{ type: "said", id, ok, interrupted? }` when playback ends, so a game can open a reaction window only after the line is spoken)
  - `{ type: "state", summary: string, phase: string, scores?: Record<name, number> }` (the host renders it as `data-little` readouts so the agent can narrate and answer questions)
  - `{ type: "moment", title, caption?, players?: string[], kind?: "funny" | "win" | "fail" | "clutch" | "bot" | "award", clip?: "pose" }` (fire and forget, no reply; send a few per game, about 3 moments and 2 to 4 `award`s). The host keeps them in the TV's memory book (localStorage per household profile) and after `done` shows "Best moments" beside the final leaderboard, replays the last ~2.5 s of stick figures for `clip: "pose"` in camera games, then a "Starring <name> as <award title>" credits roll. The agent tool `show_memories` replays the all-time best on this TV.
  - `{ type: "done" }` (back to lobby)

  Camera, through the host's `sense.motion` (Leo's Claude, 13:56; camera games are 2 players max):
  - game → host `{ type: "motion_start", mode?: "people", actions?: string[], held?: string[], controls?: string[], maxPlayers?: number }` and `{ type: "motion_stop" }`. Prefer `mode: "people"`: one raw `sense.motion` stream with phantom filtering, numbered figures and skeleton-based arm raises (the semantic session missed most raises, and two streams crash the provider). The host then reports figures as slots; phones can claim "that's me". In people mode each `motion` frame also carries `poses: [{ slot, pose }]` with whole-body poses derived from the skeleton (airplane arms, hands on head, lean left/right, squat, jump), so games can ramp from single-arm raises to body poses and combos. Request only what the current phase needs: the session status is aggregate across every requested semantic, and over-asking keeps it flapping ready/paused and loses actions.
  - host → game `{ type: "motion", actions: [{ id, side?, slot }], held: [{ id, side?, slot }], controls: [{ id, value, slot }] }` for confirmed edges and current values, and `{ type: "motion_status", state, reason?, slots: [{ slot, state }] }`.
  - Observed on the real TV: 20 Hz, two people tracked as slots 0/1; single-arm raises reliable, both-arms raise weak, squats and swipes not detected. Design around single-arm actions.
  - `{ type: "ai", id, instruction, context?, schema? }`: the host runs it on the Little SDK's
    `app.compose` and answers `ai_result` with `data` (the JSON matching `schema` when one is given,
    otherwise text)
  - `{ type: "ai_image", id, hint }`: the host runs `app.image` and answers `ai_result` with `url`
  - `{ type: "bot_answer", id, prompt, humans: string[], imitate?: string[], caught?: string[], effort?: "joke"|"lazy"|"room" }`:
    an AI player's answer that must pass as human; the host answers `ai_result` whose `data` is `{ text }`
  - The host runs `shared/humanize.ts` over 4 `app.compose` candidates for `bot_answer` (tell rejection,
    `pickMostHuman`, style post-processing, typos) and returns the winner.

  AI calls: `id` is the game's own correlation id (the host echoes it, nothing more). A result can
  take a few seconds, so ask early (e.g. when a round opens) and keep a timeout of your own. When `ok`
  is false (or no answer comes) the game must keep working on fallback content (canned answers, an
  emoji instead of an image). Because the host makes the call, bots and AI players need no API key of
  their own, and nothing secret is in the bundle.

  The only direct model-API call in the system is POST /author (the coding agent). Every other AI use,
  bots, prompts, the host's own guesses, narration, images, goes through the Little SDK on the TV host
  (app.compose, app.image, voice.say), reached from bundles only via the bridge (ai, ai_image,
  bot_answer → ai_result). Bundles have no network.

- The phone side needs nothing new: bundles use the declarative screens (with an optional `deadline`),
  and `custom` html for anything special.

## The room is the cast (Nelson, after Whodunit Live)

The first game authored from the real TV ("Whodunit Live") ran its own story: four invented
suspects, everyone voting on fictional characters. These games are about the people in the room.
The skill, `CONTRACT.md` and the Worker's `/author` prompt now open with "Design rules
(non-negotiable)": real names and ids, an actionable phone screen for every joined player every
round, tiered roles (2 to 4 active, everyone else judges, bets or votes; rotate) when the room
is bigger than the roles, works with 2 and with 12, AI host and bots only as flavour, 30 to 90 s
rounds, spoken TV reveals, moments and awards naming real players. The smoke harness fails a
game where any joined player (the late joiner too) never gets a buttons/text/pad/custom screen,
or fewer than 2 are sent (warn only when `phonesRequired` is false), warns when phone buttons
offer named characters who are not players, and prints a `participation` line per pass.


## Game scope (built)

Authored games seeded with Room memory name specific people, so they stay on the TV that asked.
Details and tests: relay/README.md "Game scope"; type `BundleMeta` in shared/protocol.ts.

- `meta.scope: "global" | "tv"` (absent = global), `meta.tvId` (1–64 chars of `[A-Za-z0-9._-]`),
  `meta.crew` (sorted guids present at authoring time). Hand-built bundles are global:
  `pnpm games:publish` refuses a meta with `scope: "tv"`.
- The runner publishes `"tv"` when the job's `context.tvId` is a string, or a Room memory block with
  real history went into TASK.md, or `context.players` carries guids; `tvId = context.tvId` or
  `"unknown-tv"` when none was sent. Otherwise global. The job log says
  `publishing <id> (scope tv, crew 3)`.
- `GET /games` returns global bundles only; `GET /games?tv=<tvId>` returns global plus that TV's own
  (newest first, sample last). `GET /games/:id/{meta.json,tv.html}` of a `"tv"` bundle needs
  `?tv=<its tvId>`, else 404, so another TV cannot start it by guessing the id.
- **TV side (Leo):** `create_game` must send `context.tvId` with the players, and `list_games` /
  `start_game` must call `GET /games?tv=<tvId>` and `/games/:id/…?tv=<tvId>`. Until then the TV sees
  only global games, and authored games with players land under `"unknown-tv"`.
- Where `tvId` comes from: the host's household or device id from the SDK environment if available,
  else a per-TV id the host generates once and keeps in localStorage next to `lr.memories.v1`.
- Later: "share this game" could re-author a `"tv"` bundle into a global one by stripping the
  memory-specific text (a new job with no tvId, no player guids and no memory block). Memory book
  entries keep `room` and `crew`; `show_memories` and the Room memory block are already guid-scoped.

## Memories (sketch, Nelson 15:20): the recap is the harvest

Goal: games and the host remember people across rooms and days, and authored games are seeded with
that history. One source of truth: the `moment` messages the host already harvests for the recap and
the memory book. No second schema.

- **Identity.** The phone shell keeps a per-device `guid` (generated once, in localStorage, never
  tied to the typed name) and sends it on every join; the relay stamps it onto `Player` (`guid`), so
  the TV sees `{ id, name, guid }`. Hand-built and authored games put player ids in
  `moment.players` as today; the host resolves ids to guids when it saves.
- **Harvest = Leo's memory book.** The host already saves moments and awards per household
  (tv/src/game/memories.ts, localStorage `lr.memories.v1`, the source of truth):
  `{ moments: Moment[] (newest first, max 60, only 20 keep clips), results: GameResult[] (max 30) }`.
  - `Moment = { id ("m_<base36 time + 4 chars>"), at (epoch ms), game (title), title (≤120),
    caption? (≤200), players?: string[] (display names, ≤6), kind?: "funny"|"win"|"fail"|"clutch"|"bot"|"award"
    (free string), clip?: ClipFrame[] }`
  - `ClipFrame = { t (ms relative to the moment, negative, ~2.5 s window), people: { n (camera
    figure 1|2), pts: number[] (34 numbers, COCO-17 × [x,y], 0..1, 3 decimals, -1,-1 missing) }[] }`
  - `GameResult = { at, game, winner?, scores: Record<name, number> }`
  - Guid additions (agreed with Leo): `Moment` gets `playerGuids?: string[]` (parallel to `players`),
    `crew: string[]` (sorted guids of the room) and `room` (code); `GameResult` gets `crew` and, when
    known, `winnerGuid?` and `scoresByGuid?: Record<guid, number>`.

  After `done`, the host posts the game's moments to the Worker:
  `POST /memories { tvId?, room, hostToken, game, at, moments: Moment[], result?: GameResult }`,
  authenticated with the room's `hostToken` (checked against the Room DO). The Worker keeps the whole
  post (clips included) at `memories/game/<room>-<at>.json` and compact copies (no clips) per guid
  (`memories/guid/<guid>.json`, 60 moments / 30 results) and per crew
  (`memories/crew/<sha256 of sorted guids joined by ",">.json`, 60 moments). Types in
  shared/protocol.ts; routes and layout in relay/README.md "Memories".
- **Read back.** `GET /memories?guids=a,b,c` → `{ players: { [guid]: { names (≤5), games, lastSeen,
  awards: [{ title, game, at }], moments (≤10), results (≤5) } }, crews: [{ guids, games, moments (≤10) }] }`;
  crews are the full set and each pair (first 6 guids) that played together as a room.
- **Authoring.** The TV's `create_game` sends `context.players: [{ id, name, guid }]`; the runner
  fetches their memories and writes a "Room memory" block into TASK.md (who wins, who got fooled,
  standing jokes), so the game opens with callbacks and names real history in its own moments.
- **Live commentary (SDK only).** The host renders a "Room memory" readout for the present players
  so the Little agent narrates with it, and answers a `recall` bridge message
  (game → host `{ type: "recall", players?: string[] }`, host → game `{ type: "recalled", memories }`)
  for reveal lines mid-game. `show_memories` keeps replaying the all-time best on this TV.
- **Consent.** "Forget me" on the phone's join screen deletes that guid's records on the Worker
  (`DELETE /memories/:guid`: index and crew files deleted, game files and co-players scrubbed) and
  asks the host to drop it from the memory book; memories only surface when the person is in the room.

Ownership: guid + relay stamping + `/memories` store + runner injection on Nelson's side; saving
with guids, the post after `done`, the readout and `recall` on Leo's side.

## Start gate (Nelson, 14:59)

A built game never starts by itself. When an authoring job reaches `done`, the host shows
"<title> is ready" with the join code and says "say start when everyone is in". Only `start_game`
(voice or tool) launches it, and it refuses with a spoken reason while joined players are fewer
than `meta.minPlayers` (or nobody has joined, unless `meta.phonesRequired` is false). The same gate
applies to hand-built games.

## Stage-safety gate for freshly authored games (Leo's Codex, 12:51)

`/author` validates a bundle's structure, not whether it actually starts. Before `start_game` on a
new bundle, the TV host loads its `tv.html` in a hidden sandboxed iframe, sends `init` with two fake
players, and requires a `state` and at least one `screen` within a short timeout (5 s). If the bundle
errors or stalls, the host keeps the current game (or the sample) playable and tells the agent why.
This lives in the host (`tv/`), since only the host can run a bundle.

Image URLs: `app.image()` returns a `data:` URL today (Little SDK docs), and the bundle CSP in
`relay/src/games.mjs` allows `img-src data: blob:`, so `ai_result.url` renders inside a bundle as is.
If the SDK ever returns an https URL, the host converts it to a data/blob URL before answering.

## Lobby card (per game, authored) — proposed 2026-11-07 16:15, from Nelson

Today the lobby previews a focused game with its palette, hook and seats. Nelson wants the full
Jackbox treatment: every game ships its own lobby art, authored by the game's author, filling the
right side of the lobby; the left side is a rolodex of games to scroll through; the voice agent can
start a named game as well as the focused one.

### Layout (host, tv/)
- Left column (about a third of the width): the rolodex. A vertical list of game tiles the remote
  scrolls with up/down; the focused tile is enlarged; order: this TV's own games and recently played
  first, then global. `list_games` is unchanged.
- Right pane (the rest, full height): the focused game's lobby card in a sandboxed iframe, the
  theme-kit `<style data-host-theme>` prepended as for tv.html. Fallback when a bundle has no card:
  the current palette + hook + seats panel.
- Voice: `start_game { game: string }` fuzzy-matches title, id and hook ("start the noir one"),
  `start_selected {}` starts the focused tile, `select_game { game }` moves the rolodex focus.
  The start gate (min players, explicit start) applies to all three.

### The card (bundle, `lobby.html` beside `tv.html` and `meta.json`)
- Self-contained: inline CSS and SVG, no network, no external fonts, no audio, no `say`.
  Laid out in the iframe's own vw/vh; never scrolls; designed for a pane around 1280x1080 and
  tolerant from 1100x900 to 1400x1080 (the host owns the exact size).
- Must contain: (1) a title treatment, the game's name as art (typographic or SVG, not a plain
  heading); (2) a backdrop in the palette using the game's motifs; (3) the room's players drawn as
  the game's seats (name + icon, up to 12, join order, the first player marked as host/VIP, empty
  seats shown as "join" slots up to maxPlayers); (4) the join block: the join URL and room code,
  large and legible from the couch; (5) the hook line; (6) a status line driven by `ready`
  ("Needs 2 more" / "Everyone in? Say start"); (7) idle motion (something always moves).
  Look and voice rules apply (palette tokens, three sizes, no bold, no emoji, no pills).
- Bridge (postMessage, host → card), sent on load and on every change:
  `{ type: "lobby", code, joinUrl, players: [{ id, name, guid?, connected }], minPlayers,
     maxPlayers, ready: boolean, focused: boolean }`
  Card → host: `{ type: "lobby_ready" }` once after first paint. Nothing else.
- meta.json keeps `palette`, `hook`, `seats`; adds `"lobby": true` when the file exists.

### Relay and publishing
- `POST /author/complete` accepts `lobby` (html string) beside `html`; stored at R2
  `games/<id>/lobby.html`; `GET /games/:id/lobby.html` with the same scope rules as tv.html;
  `GET /games` entries carry `lobby: true|false`. `pnpm games:publish` uploads lobby.html when
  present. Hand-built games add their own lobby.html (Leo's side for Who's the Bot and Little
  Says; ours for sample and whodunnit).

### Harness
- lobby.html exists and loads in jsdom at 1280x1080 with no errors; after the `lobby` message all
  player names, the code and the join URL text are in the DOM; `ready` false/true changes the
  status line; a title element ≥ 14vh or an `<svg>` title exists; the look checks run on it too.
  Missing card → FAIL for authored games (the agent must ship one); WARN for hand-built bundles
  until they have one.
