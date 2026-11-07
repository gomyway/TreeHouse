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
| `POST /author` `{ prompt, context? }` → 202 `{ jobId, status }`; poll `GET /author/:jobId` (every 2 s, give up at 4 min) until `done` with `{ id, meta }`; `POST /author?wait=1` → `{ id, meta }` inline | Authoring manager. Calls the Claude API with the bundle contract below (job runs in a Durable Object alarm, state in R2 `jobs/<jobId>.json`, see relay/README.md); secret `ANTHROPIC_API_KEY` via `wrangler secret`. `AUTHOR_FAKE=1` returns a canned bundle for tests. | Nelson's side |
| `GET /games`, `GET /games/:id/meta.json`, `GET /games/:id/tv.html` | Game storage (R2 bucket `GAMES`; only `/author` writes). A hand-written sample bundle is seeded so the TV can pull before authoring works. | Nelson's side |
| Game runner in `tv/` | Loads `tv.html` into a sandboxed iframe and bridges it to the relay + the Little agent | Leo's side |

## Game bundle

- `meta.json`: `{ id, title, description, phases: string[], minPlayers, maxPlayers, createdAt, prompt }`
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
  - `{ type: "say", text }` (the host asks the agent to speak it)
  - `{ type: "state", summary: string, phase: string, scores?: Record<name, number> }` (the host renders it as `data-little` readouts so the agent can narrate and answer questions)
  - `{ type: "done" }` (back to lobby)
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
