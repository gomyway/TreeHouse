# Shared infra plan (draft, edit freely)

Goal for today: a phone + TV + relay backbone that any living-room idea can sit on.
The **TV is the server**. The relay is a dumb public pipe. Phones join with a short
code, like jackbox.tv.

## Shape

| Piece | Lives in | Role |
|---|---|---|
| TV app | `tv/` (the Little app, moved from the repo root) | Owns all state and game logic. Runs in the TV's browser. Exposes tools so the TV's agent can drive it by voice. |
| Relay | `relay/` (Node + `ws`) | Assigns room codes, forwards frames between the TV socket and the phone sockets, serves the phone shell as static files. No logic. |
| Phone shell | `phone/` (Vite, vanilla or React) | `https://<relay>/` : enter code, then render whatever **screen** the TV sends and stream whatever **sensors** the TV asks for. |
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
- `{ kind: "text", prompt, maxLength }`
- `{ kind: "pad" }` (touch joystick / drag area, streams `input` at ~20 Hz)
- `{ kind: "info", title, body }`
- `{ kind: "custom", html }` for anything generated on the fly (sandboxed iframe, postMessage bridge)

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
