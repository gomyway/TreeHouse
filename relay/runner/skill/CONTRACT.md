# Game bundle contract

A bundle is three files in the job directory:

- `meta.json`: `{ "id", "title", "description", "hook", "engine", "phases", "minPlayers", "maxPlayers", "palette", "seats", "lobby" }`
  - `id`: lowercase-kebab slug of the title (the runner replaces it with a unique one at publish).
  - `title`: short game name.
  - `description`: one or two sentences a TV agent can read aloud.
  - `phases`: the phase names your `state` messages use, e.g. `["write", "vote", "reveal", "final"]`.
  - `minPlayers` (integer >= 1), `maxPlayers` (integer, minPlayers <= maxPlayers <= 16; the runner
    clamps a larger value to 16).
  - `phonesRequired` (optional, default true): set false only for camera-only games that must
    start with nobody joined; phones then stay optional for names and bets.
  - `palette`: one of `"Noir"`, `"Broadcast"`, `"Paper"`, `"Arcade"`, `"Campfire"`, `"Lagoon"` (see
    "Look and voice rules"); the CSS uses that palette's four tokens.
  - `engine`: the humour engine, one of `"H1"` to `"H12"` (see "Game design rules (approved)").
  - `hook`: one sentence naming the game's world ("A heist crew cracking the vault one bluff at a time.").
  - `seats`: the 6 to 12 seat icons tv.html draws, `[{ "name": "<variant name>", "svg": "<svg …>" }]`
    (see "Roster seats"); the host draws the room in them from the picker.
  - `lobby`: `true` when the bundle ships `lobby.html`. The runner sets it; do not write it.
  - Do not add `createdAt` or `prompt`; the server adds them.
- `tv.html`: one self-contained page. The TV loads it into a sandboxed iframe
  (`sandbox="allow-scripts"`, no same-origin) and bridges it to players' phones and to a voice agent.
  You never see the phones' code; you drive them by posting declarative screens.
- `lobby.html`: the game's lobby card, one self-contained page the TV lobby shows while the room
  joins (see "Lobby card").

## Design rules (non-negotiable)

- The room is the cast: the players in `init` / `players` are the game. Use their real names and
  ids everywhere (TV, `say`, phone prompts and buttons, `state`, `moment`).
- Never invent player characters or NPC contestants (fictional suspects, detectives, rivals). An
  AI host or hidden bots may add flavour (Who's the Bot's bot), but humans drive every round.
- Every joined player gets an actionable phone screen every round: `buttons`, `text`, `pad` or
  `custom`. `info` is only for beats between actions.
- When roles are fewer than players, tier participation: 2 to 4 active roles, everyone else
  judges, bets, votes or answers a side question that round; rotate the active roles.
- Works with 2 players and with 16 (`maxPlayers` is at most 16). Late joiners get the current screen and join the rotation.
- Rounds are 30 to 90 s. Big reveals on the TV with a spoken `say` line naming the players.
- About 3 `moment`s and 2 to 4 `award`s, each naming real players.
- The harness fails a game where any joined player never got an actionable screen
  (unless `meta.phonesRequired` is false).

## Game design rules (approved)

Nelson approved these (DP-01 to DP-17, research/jackbox/analysis/design-points.json). They say what
makes the game funny and fair; the harness checks the ones marked "Harness".

- **The Room plays as one (DP-01).** Run every input phase in parallel. When roles are fewer than
  players, give everyone else a scoring input and fold their answers into one collective player,
  "the Room", with its own score on the TV; the host addresses it by that name.
- **Reveal one entry per beat (DP-02, DP-07).** Entries stay anonymous until the room has voted or
  guessed. Then one entry per beat, 700 ms or more apart: the host `say`s the entry, then names the
  author and who fell for it, the truth or the winner last. At 9 to 12 players reveal the top entries
  plus the funniest miss (about 8 beats, 40 s). Harness: a reveal phase (`reveal`, `result`,
  `answer`, `score` in its name) that adds 3 or more entries in one go fails.

  ```js
  const beats = entries.map((e) => () => { show(e); send({ type: "say", text: `"${e.text}"` }); });
  beats.push(...entries.map((e) => () => send({ type: "say", text: `${nameOf(e.author)} wrote it. ${and(e.fooled.map(nameOf))} fell for it.` })));
  beats.push(() => { showTruth(); send({ type: "say", text: `The truth: "${truth}"` }); });
  beats.forEach((b, i) => later(i * 1800, b)); // one beat at a time, >= 700 ms apart, truth last
  ```
- **Pick a humour engine (DP-03).** The mechanism makes the joke, not the players' wit. Pick one and
  write its id in `meta.engine` (harness: missing or not H1..H12 fails):
  H1 head-to-head blank, H2 multi-part combo, H3 lies hidden among a true fact, H4 misreading a bad
  artifact, H5 context swap, H6 word constraint, H7 bad tool, H8 punishment, H9 inversion prompt
  (ruin it, split the room), H10 prompts about the players, H11 calibration gap, H12 table talk
  under pressure. Prompts come from a canned pool plus `ai` additions and never repeat in a session.
- **Decoys score both ways (DP-04).** When players write decoys, pay for finding the truth and for
  every player your decoy fools. Reject a decoy that matches the truth (lowercase, strip punctuation)
  and ask again; `bot_answer` adds a house decoy at 2 to 3 players.
- **Constrain the tool (DP-05).** Text `maxLength` 40 to 60, short timers, one colour, word banks:
  clumsy output is the joke and skill does not decide the winner. Harness: maxLength above 80 warns.
- **Everyone can still win (DP-06).** Escalate values each round, keep knocked-out players scoring,
  post `state.scores` after each reveal, and end with a final round that changes the answer format
  (one prompt for all, pick your favourite earlier answer) or multiplies stakes. Never a random spin.
- **Memory is content (DP-08).** When TASK.md has a Room memory block, build at least one prompt or
  award from it ("Last time Bo froze. Write Bo's excuse."; "defend your title"). Harvest one personal
  answer early and pay it off later. Structure stays identical for people with no history.
- **Chain authorship (DP-09).** Route one player's output to another player as raw material (twist
  it, answer it blind, combine it) and credit both in the reveal.
- **Commit before context (DP-10).** Ask an innocent question first; reveal what the answer is used
  for (the real prompt, the partner's half) afterwards.
- **Vote-share points and a consolation (DP-11).** Score `round(100 * votes / voters)`; pay the loser
  or the victim something ("Ana, you lost, but you were the material").
- **Side bets for non-authors (DP-12).** Whoever is not authoring this beat bets on the winner,
  predicts a friend's pick or wagers confidence; it pays out in the reveal, named by the host.
- **A side channel in every reveal (DP-13).** During each reveal and final beat every phone has
  something light to do: a like for the entry on screen, "who wrote this", nominate for an award. It
  feeds an award ("Room favourite"). Harness: an info-only phone held over 15 s while the TV is in a
  reveal or final phase fails.
- **Do not (DP-14).** One player performs or decides while the others only watch or thumb-vote.
  The spotlight is fine; idle is not: every other phone gets a scoring input.
- **Do not (DP-15).** Make comedy depend only on players being witty on demand. Free text needs a
  transformation (pairing, recontext, decoy); a bare "write something funny, vote funniest" loop fails.
- **Do not (DP-16).** Let reaction speed, dexterity or continuous control (`pad`, camera) decide
  outcomes. Use deadline-bounded inputs; speed is at most a small bonus on TV receipt time.
- **Do not (DP-17).** Run rounds of two-way votes or true/false on the same material. Give 3 or more
  options or a scale, and vary the input between rounds. Harness: 3 two-option screens in a row warn.
- **Spoken content is exempt from the 12-word cap.** Quoted player text and game content (a player's
  answer, a riddle, a fact) do not count toward the `say` cap, but go in their own `say` beat, in
  double quotes: `` say(`"${answer}"`) ``, then the reaction as the next beat.

The static gate (`src/gate.mjs`) runs first in the harness and again when the Worker saves the
bundle; the same failures come back as 400s, so fix every `gate` line.

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
this exact group). It is content, not only flavour (DP-08): build at least one prompt or award
from it when it exists ("Last time Bo froze. Write Bo's excuse."; "defend your title"), and use it
for an opening callback, award titles that riff on an old one, `say` lines and reveals ("Bo, last
time you froze like a statue"). The structure (phases, screen kinds) must stay exactly the same for
people with no history, must not wait for anyone on the list (the `init` / `players`
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
