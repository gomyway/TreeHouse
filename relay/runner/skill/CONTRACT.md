# Game bundle contract

A bundle is two files in the job directory:

- `meta.json`: `{ "id", "title", "description", "phases", "minPlayers", "maxPlayers" }`
  - `id`: lowercase-kebab slug of the title (the runner replaces it with a unique one at publish).
  - `title`: short game name.
  - `description`: one or two sentences a TV agent can read aloud.
  - `phases`: the phase names your `state` messages use, e.g. `["write", "vote", "reveal", "final"]`.
  - `minPlayers` (integer >= 1), `maxPlayers` (integer >= minPlayers).
  - `phonesRequired` (optional, default true): set false only for camera-only games that must
    start with nobody joined; phones then stay optional for names and bets.
  - `palette`: one of `"Noir"`, `"Broadcast"`, `"Paper"`, `"Arcade"`, `"Campfire"`, `"Lagoon"` (see
    "Look and voice rules"); the CSS uses that palette's four tokens.
  - Do not add `createdAt` or `prompt`; the server adds them.
- `tv.html`: one self-contained page. The TV loads it into a sandboxed iframe
  (`sandbox="allow-scripts"`, no same-origin) and bridges it to players' phones and to a voice agent.
  You never see the phones' code; you drive them by posting declarative screens.

## Design rules (non-negotiable)

- The room is the cast: the players in `init` / `players` are the game. Use their real names and
  ids everywhere (TV, `say`, phone prompts and buttons, `state`, `moment`).
- Never invent player characters or NPC contestants (fictional suspects, detectives, rivals). An
  AI host or hidden bots may add flavour (Who's the Bot's bot), but humans drive every round.
- Every joined player gets an actionable phone screen every round: `buttons`, `text`, `pad` or
  `custom`. `info` is only for beats between actions.
- When roles are fewer than players, tier participation: 2 to 4 active roles, everyone else
  judges, bets, votes or answers a side question that round; rotate the active roles.
- Works with 2 players and with 12. Late joiners get the current screen and join the rotation.
- Rounds are 30 to 90 s. Big reveals on the TV with a spoken `say` line naming the players.
- About 3 `moment`s and 2 to 4 `award`s, each naming real players.
- The harness fails a game where any joined player never got an actionable screen
  (unless `meta.phonesRequired` is false).

## Look and voice rules (non-negotiable)

These set how the TV page looks and how the host talks. The harness checks them and prints a `look` line.

- **One palette, picked for the theme.** Choose ONE of the six below, write its name in
  `meta.palette`, define its four tokens at `:root` and colour everything with them, plus pure
  black or white for shadows. One accent only.

  | Palette | `--bg` | `--ink` | `--muted` | `--accent` | Mood |
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

## The bridge (window.postMessage, exactly these shapes)

Host → game (listen with `window.addEventListener("message", e => { const m = e.data; ... })`):

- `{ type: "init", players: Player[], code: string }`: sent once when the game starts. Start the game here.
- `{ type: "players", players: Player[] }`: full current list, after any join, rejoin or leave.
- `{ type: "input", player: playerId, data }`: a phone's input (shapes below).
- `{ type: "sensor", player: playerId, kind: "gyro" | "camera" | "mic", data }`: sensor readings you asked for.
- `{ type: "voice", text: string }`: optional: a viewer's spoken instruction relayed by the agent
  ("skip", "make it harder"). Handle it sensibly or ignore it.
- `{ type: "ai_result", id: string, ok: boolean, data?, url?: string, error?: string }`: the answer
  to one of your `ai` / `ai_image` / `bot_answer` requests (below).
- `{ type: "motion", actions: [{ id, side?, slot }], held: [{ id, side?, slot }], controls: [{ id, value, slot }] }`:
  camera motion frames while motion is on (below).
- `{ type: "motion_status", state, reason?, slots: [{ slot, state }] }`: camera tracking status.

`Player = { id: string, name: string, connected: boolean }`. Players can join mid-game, leave, and
come back with the same id: send late joiners the current screen.

Game → host (`window.parent.postMessage(msg, "*")`):

- `{ type: "screen", to: playerId | "*", screen: Screen }`: what a phone shows now.
- `{ type: "ask", to: playerId | "*", kind: "gyro" | "camera" | "mic", on: boolean, hz?: number }`: start/stop a phone sensor.
- `{ type: "play", to: playerId | "*", text?: string, url?: string }`: make a phone speak text or
  play a sound (url must be a `data:` URL).
- `{ type: "say", text: string }`: the TV's voice agent says this aloud. Use for announcements:
  round starts, results, winners. 12 words or fewer (player names not counted), one per beat.
- `{ type: "state", summary: string, phase: string, scores?: { [playerName]: number } }`: post after
  every meaningful change. `summary` is plain English the agent reads to narrate and to answer
  "who's winning?"; `phase` is one of `meta.phases`.
- `{ type: "done" }`: the game is over; the host returns to the lobby. Post it a few seconds after
  showing final results.
- `{ type: "moment", title, caption?, players?: string[], kind?: "funny"|"win"|"fail"|"clutch"|"bot"|"award", clip?: "pose" }`:
  fire and forget, no reply. Send about 3 moments and 2 to 4 `kind: "award"` moments per game (one
  award per standout player, title like "Most Robotic Human", `players` holding real player names);
  the TV builds the end-of-game recap and credits from them.
- `{ type: "ai", id: string, instruction: string, context?: any, schema?: JSONSchema }`: the host runs
  a language model for you (the Little SDK's `app.compose`) and answers with `ai_result`. `data` is
  the JSON object matching `schema` when you give one, otherwise text.
- `{ type: "ai_image", id: string, hint: string }`: the host generates an image (`app.image`) and
  answers with `ai_result`; `url` is the image to show (set it as an `<img>` src at runtime).
- `{ type: "bot_answer", id: string, prompt: string, humans: string[], imitate?: string[], caught?: string[], effort?: "joke" | "lazy" | "room" }`:
  an AI player's answer to `prompt` that must pass as human. `humans` are this round's (or the last
  round's) human answers so the host can match their style, `imitate` optional sample answers to
  resemble, `caught` answers of bots already spotted (to avoid), `effort` how hard to try. The host
  composes several candidates, rejects the ones that read as machine-written, shapes the best to
  the room (case, punctuation, length, typos) and answers with `ai_result` whose `data` is `{ text }`.
- `{ type: "motion_start", actions?: string[], held?: string[], controls?: string[], maxPlayers?: number }`
  and `{ type: "motion_stop" }`: camera motion (below).

## Room memory

TASK.md may carry a "Players expected at start" list and a "Room memory" block: what the relay
remembers about these people from earlier games (games played, awards, recent moments, moments of
this exact group). Use it for flavour only: an opening callback, award titles that riff on an old
one, `say` lines and reveals ("Bo, last time you froze like a statue"). The game must play exactly
the same for people with no history, must not wait for anyone on the list (the `init` / `players`
list is the truth), and names history only for players who are actually in the room. "No history
yet" means a first game: say so warmly if you like, never invent a past.

What you send becomes the next game's memory: the host saves every `moment` with the guids of the
players it names, so put the real players' names in `players` (never "Player 1" or invented
characters), and keep titles short and specific. `kind: "award"` moments become the credits roll
and the player's award list next time.

## AI players and generated content

You never call a model or any API yourself: the only way a game uses AI is the bridge (`ai`,
`ai_image`, `bot_answer`, answered by `ai_result`), which the host runs on the Little SDK; the game
has no network. For an AI player's answer that should pass as human, prefer `bot_answer` over raw
`ai`: the host then handles style matching and tell removal for you. Use `ai` for bots that play
alongside the humans, generated prompts, judging or commentary. `id` is your own correlation id;
the host just echoes it. A result takes a few seconds, so ask early (when a round opens, not when
it closes) and keep your own timeout of about 15 s. If `ok` is false, the result never comes, or
`data` has the wrong shape, keep going with fallback content you wrote into tv.html (canned
answers, a text glyph or inline SVG instead of an image). The game must be fully playable with every AI call
failing. The host makes the call, so the game needs no API key. Never reveal a bot's identity on a
phone screen unless the game wants it known.

Example, a bot answering in the room's style with a canned fallback:

```js
const pending = {}; let aiSeq = 0;
function ai(instruction, context, schema, fallback, cb) {
  const id = "ai" + (++aiSeq);
  const timer = setTimeout(() => { if (pending[id]) { delete pending[id]; cb(fallback); } }, 15000);
  pending[id] = (m) => { clearTimeout(timer); cb(m.ok && m.data && typeof m.data.answer === "string" && m.data.answer.trim() ? m.data.answer.trim() : fallback); };
  window.parent.postMessage({ type: "ai", id, instruction, context, schema }, "*");
}
// in the message listener: if (m.type === "ai_result" && pending[m.id]) { const f = pending[m.id]; delete pending[m.id]; f(m); }
// when the round opens (myRound guards against a result landing after the phase moved on):
const myRound = round;
ai("You are a human at a party game. Answer the prompt in under 12 words, casual, lowercase, like the example answers. Reply with the answer only.",
   { prompt: question, examples: lastRoundHumanAnswers },
   { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
   CANNED[Math.floor(Math.random() * CANNED.length)],
   (text) => { if (round === myRound) answers.set(BOT_ID, text); });
```

## Camera motion (optional)

The TV host can track up to two people in front of the TV camera (Little SDK). Use it only when
the request is about moving; most games should not.

- Send `{ type: "motion_start", actions: ["raise_left", ...], held: [...], controls: [...], maxPlayers: 2 }`
  when a phase needs motion, and `{ type: "motion_stop" }` when it ends. Request only what the
  current phase needs.
- The host answers `motion_status` (`state` reaches `"ready"` when tracking works; `slots` say which
  of slot 0 and slot 1 are tracking) and then streams `motion` frames: `actions` are one-shot events
  (`{ id, side: "left" | "right", slot }`), `held` are poses being held now, `controls` are
  continuous values (`{ id, value, slot }`).
- Camera games are 2 players max (slots 0 and 1). Map slot 0 / slot 1 to two of the joined players
  and say so on the TV.
- Design around single-arm raises (left or right): they are the most reliable action.
- The game must stay playable when `motion_status` never reaches `"ready"` (no camera, nobody in
  frame, an error): after a few seconds fall back to phone buttons for the same choices.

## Screen kinds

The phone renders these; nothing else exists. Every kind also takes `deadline?: number` (epoch ms,
e.g. `Date.now() + 45000`): the phone shows a big countdown and at zero disables its inputs and
shows "Time's up, look at the TV". A text screen then auto-submits what was typed, or sends
`{ kind: "text", text: "", late: true }` if nothing was; a buttons screen sends nothing. Phone
clocks are within about a second of yours: close the round on your own TV timer and accept answers
up to 1.5 s after the deadline.

- `{ kind: "info", title: string, body?: string }`
- `{ kind: "buttons", prompt?: string, items: { id: string, label: string }[] }` → input data `{ kind: "button", id }`
- `{ kind: "text", prompt: string, maxLength?: number, placeholder?: string }` → input data
  `{ kind: "text", text, late?: true }` (the phone shows a live "n/max" counter; default max 140)
- `{ kind: "pad", label?: string }` → a touch joystick streaming input data `{ kind: "pad", x, y }` (each -1..1) at ~20 Hz
- `{ kind: "custom", html: string }` → your own self-contained HTML in a sandboxed iframe on the
  phone; it sends input with `parent.postMessage({ type: "input", data }, "*")`. Use only when the
  declarative kinds cannot express the interaction.

Sensors: `gyro` sends orientation/motion readings at `hz`; `camera` sends a JPEG data URL snapshot
(`hz` 0 = one snapshot); `mic` sends loudness levels. Phones disable a buttons screen after one
tap, so send a fresh screen for each new question.

## Rules for tv.html

- One complete HTML document, fully self-contained: inline `<style>` and `<script>` only. No
  external scripts, stylesheets, fonts, images, CDNs or URLs of any kind (the one exception: an
  image url returned in `ai_result`); no fetch, XMLHttpRequest, WebSocket, EventSource, `import()`,
  localStorage or cookies (the sandbox blocks them). Draw with CSS, inline SVG or canvas; no emoji
  (see "Look and voice rules").
- It is shown on a television seen from 3 metres: one palette from "Look and voice rules", high
  contrast, exactly three text sizes (display >= 10vh, body >= 4vh, tiny >= 2.4vh), size everything
  in vh/vw, no scrolling, one idea on screen at a time.
- Before init arrives, show a short "waiting" title. All game logic lives in tv.html; the host does
  nothing but forward messages.
- Be robust: ignore unknown message types and malformed input, never assume a player id is known,
  cope with 1 player, end rounds on a timer as well as when everyone has answered, guard timeouts
  so a stale one cannot fire after the phase moved on.
- Post a `state` and at least one `screen` (to `"*"` or to every player) right after `init`: the TV
  refuses a bundle that is silent for 5 s.
- Keep it compact and readable (a few hundred lines at most).

## Testing

`node harness/smoke.mjs` (from the job directory) must print `SMOKE PASS`. It is the gate: the
runner re-runs it after you finish and publishes only on PASS.
