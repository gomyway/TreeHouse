# relay

One Cloudflare Worker, three route families (PLAN.md, "Three public addresses"):

| Routes | What | Code |
|---|---|---|
| `wss://…/host`, `wss://…/join?code=`, `GET /rooms/:code`, `GET /health` | Relay: one Durable Object per room routes frames between the TV and phones. The phone shell (`../phone`) is served as static assets from `/`. | `src/worker.mjs` |
| `GET /games`, `GET /games/:id/meta.json`, `GET /games/:id/tv.html` | Game storage on R2 (binding `GAMES`, bucket `little-redwood-games`). `/games` lists every meta, newest first, with the built-in sample last. | `src/games.mjs` |
| `POST /author` `{ prompt, context? }` → 202 `{ jobId, status }`; `GET /author/:jobId` → job; `POST /author?wait=1` → `{ id, meta }` | Authoring manager: Claude writes a game bundle, the Worker validates it (one retry with the errors fed back) and stores it under a new 8-letter id. Runs as a job by default (see "Authoring jobs"); `?wait=1` runs inline. 400 for a missing prompt. | `src/author.mjs` |

`/games` and `/author` answer CORS with `access-control-allow-origin: *` (OPTIONS preflight → 204), because the TV app runs on another origin.

## Authoring jobs

Writing a full tv.html can take longer than a TV should hold one request open, so authoring is a job.

**Async (default).** `POST /author { prompt, context? }` answers at once with
`202 { "jobId": "…12 chars…", "status": "queued" }`. The job runs in the `AuthorJob` Durable Object
(binding `AUTHOR_JOB`, one per job): the POST stores the input and sets an alarm for now, and the alarm
handler does the generation. Not `ctx.waitUntil`: Cloudflare cancels `waitUntil` work 30 s after the
response is sent, and an alarm handler gets 15 minutes. Each attempt has a 90 s deadline and the one
retry gets its own 90 s (after a validation failure or a timeout), so a job can take about 3 minutes.

`GET /author/:jobId` returns the job state, stored in R2 at `jobs/<jobId>.json` and rewritten at each
transition (404 for an unknown id):

```json
{
  "jobId": "k3m9q2rtx7ab",
  "status": "queued | running | done | error",
  "prompt": "a two-phase quiz where…",
  "createdAt": "2026-11-07T12:00:00.000Z",
  "updatedAt": "2026-11-07T12:01:10.000Z",
  "attempt": 1,
  "id": "d3bacebb",
  "meta": { "id": "d3bacebb", "title": "…" },
  "error": "authoring failed twice: …"
}
```

`attempt` is 0 while queued, then 1 or 2. `id` and `meta` are present only when `done`, `error` only when
`error`. With `AUTHOR_FAKE` the job goes through the same states, with a 300 ms pause while running.

**Sync.** `POST /author?wait=1` runs inline and returns `{ id, meta }` (plus `fake: true` under
`AUTHOR_FAKE`), or 502 `{ error }`. Use it for tests and curl, not from the TV: it can take up to 3 minutes.

**On the TV.** After the 202, show "writing your game…" on screen and poll `GET /author/:jobId` every
2 s. On `done`, load `/games/<id>/tv.html`. On `error`, show the message and offer to try again. Give up
after 4 minutes with no `done` or `error` (the job may have been lost to a deploy).

## Local run

```sh
pnpm install
cp .dev.vars.example .dev.vars     # AUTHOR_FAKE=1: /author returns the sample, no key needed
pnpm dev                           # wrangler dev on :8787; R2 is simulated under .wrangler/
pnpm test                          # test/e2e.mjs (relay) then test/author.mjs (games + author)
node test/phone.mjs                # phone shell deadline helpers, no browser, no wrangler
```

`test/author.mjs` starts its own `wrangler dev --var AUTHOR_FAKE:1` with local state in a temp dir.

## Secrets and settings

| Name | Where | Meaning |
|---|---|---|
| `FIREWORKS_API_KEY` | `pnpm exec wrangler secret put FIREWORKS_API_KEY`; locally in `.dev.vars` (gitignored) | Key for live authoring |
| `AUTHOR_MODEL` | var | Model id, default `claude-opus-5-5` |
| `AUTHOR_FAKE` | var (`.dev.vars`, or `--var AUTHOR_FAKE:1`) | Skip the API; store the sample bundle under a new id (after 300 ms) |

Live requests use the Anthropic TypeScript SDK (it runs on Workers), streaming with adaptive thinking,
`max_tokens` 32000, and the system prompt cached. On the Opus 5.5 / Opus 5 / Sonnet 5.5 / Fable 5.1 models the request also
opts into server-side refusal fallback (`fallbacks: "default"`); a refusal that still comes back is a 502.

## Deploy

```sh
pnpm exec wrangler r2 bucket create little-redwood-games   # once
pnpm exec wrangler secret put FIREWORKS_API_KEY            # once
pnpm exec wrangler deploy
```

## How the TV pulls a bundle

1. `POST /author { "prompt": "a two-phase quiz where…" }` → `{ jobId }`, then poll `GET /author/:jobId`
   every 2 s until `done` gives `{ id, meta }` (or skip and use `sample`).
2. `GET /games` for the list, or `GET /games/:id/meta.json` for one game.
3. `GET /games/:id/tv.html` (text/html, `cache-control: no-store`, a CSP that blocks all network)
   and load it into `<iframe sandbox="allow-scripts">`, either by `src` or via `srcdoc`.
4. Bridge the iframe to the relay with `postMessage`.

## Bundle contract (summary; PLAN.md "Game bundle" is the source of truth)

- `meta.json`: `{ id, title, description, phases, minPlayers, maxPlayers, createdAt, prompt }`.
- host → game: `init {players, code}`, `players {players}`, `input {player, data}`, `sensor {player, kind, data}`, `voice {text}`.
- game → host: `screen {to, screen}`, `ask {to, kind, on, hz}`, `play {to, text|url}` (forward to the relay as-is), `say {text}` (agent speaks), `state {summary, phase, scores}` (agent narrates), `done` (back to lobby).
- Screens are the declarative kinds in `../shared/protocol.ts` (`info`, `buttons`, `text`, `pad`, `custom`).

The reference bundle is `games/sample/` ("Pick A or B": three rounds, majority scores). It is compiled
into the Worker, so `/games/sample/*` works against an empty bucket, and it is embedded in the
authoring system prompt as the example the model follows.

## Pre-built games

Every directory under `games/` that holds `meta.json` and `tv.html` is a pre-built bundle, stored in
the same bucket as authored ones. `GET /games` lists the bucket itself (every `<id>/meta.json`, newest
`createdAt` first, missing `createdAt` last), so pre-built and authored games are listed alike. If the
bucket has no `sample/meta.json`, the compiled-in sample is appended last. `index.json` is no longer
read or written.

```sh
pnpm games:publish                      # every bundle in games/ → the real bucket (wrangler r2 object put --remote)
pnpm games:publish whos-the-bot         # just one
pnpm games:publish --local              # wrangler's local simulation (.wrangler/state), for pnpm dev
pnpm deploy                             # wrangler deploy, then games:publish
```

`scripts/publish-games.mjs` checks each `meta.json`: `id` must equal the directory name, and `title`,
`description`, `phases` and `minPlayers` must be present. A missing `createdAt` is set from the file's
mtime. Other fields are kept. It prints one line per bundle and a final count, and exits 1 if any bundle failed.

`--local` writes to the same `.wrangler/state` that `pnpm dev` uses (pass `--persist-to DIR` if dev was
started with one). A running `wrangler dev` sees the objects without a restart.

**PUT /games/:id** `{ meta, html }` with header `x-publish-token` publishes over HTTP using the same
checks (200 `{ id, meta }`, 403 for a wrong token, 400 for a bad bundle). The route exists only when the
`PUBLISH_TOKEN` var or secret is set; otherwise it returns 404. It is unset in production. The script uses it with
`PUBLISH_TOKEN=… node scripts/publish-games.mjs --url http://127.0.0.1:8787`.
`test/games.mjs` (in `pnpm test`) runs its own `wrangler dev` with a test token and covers the listing order,
the PUT route and the script's `--url` path.

## Acks and offline taps

A phone `input` may carry a numeric `seq`. After forwarding it to the TV, the relay replies to that
phone with `{ type: "ack", seq, delivered: true }`; when no TV socket is attached (the TV grace window)
it replies `{ type: "ack", seq, delivered: false }` and the input is dropped. Inputs without `seq` and
all `sensor` frames are never acked. The TV gets `seq` inside the input frame and can ignore it.

The phone shell numbers every discrete input (taps, text, custom screens, the deadline auto-submit)
and keeps it until its ack arrives: an input tapped while offline is queued, and one sent into a
half-open socket is resent, in order, when the next socket opens (at most 20, none older than 30 s).
The pad's 20 Hz stream and sensor frames are never queued. The heartbeat ping now expects a pong
within 8 s (4 s when the page becomes visible again); without one the socket is closed and a new one
opened at once.

On screen: the tapped button gets an accent ring and the others lock; a check mark appears on the ack.
"Reconnecting, your answer is queued" shows when the tap happened offline, "TV is away" on
`delivered: false`, and "No answer from the TV yet" after 6 s with no ack, which unlocks the buttons.

So the TV can receive the same answer more than once: a resend after a reconnect repeats a `seq`, and
a re-tap after the 6 s timeout sends a new `seq` for the same answer. Games must treat inputs as
idempotent per player and round (last answer wins, or first answer sticks), which the game design
already requires.

## Fireworks (authoring model)

`POST /author` now calls a coding model on Fireworks AI, not the Claude API. This supersedes the
`FIREWORKS_API_KEY` rows above (table and deploy steps): that secret is no longer read, and you can
delete it with `pnpm exec wrangler secret delete FIREWORKS_API_KEY`.

The call is a plain `fetch` to Fireworks' OpenAI-compatible endpoint
`POST https://api.fireworks.ai/inference/v1/chat/completions` (no SDK). The bundle contract, parsing,
validation, single retry and 90 s per-attempt deadline are unchanged.

| Setting | How | Default |
|---|---|---|
| `FIREWORKS_API_KEY` (secret) | `pnpm exec wrangler secret put FIREWORKS_API_KEY`; locally in `.dev.vars` | none: without it (and without `AUTHOR_FAKE`) `POST /author` returns 500 |
| `AUTHOR_MODEL` | `[vars]` in wrangler.toml, `--var`, or `.dev.vars` | `accounts/fireworks/models/qwen3-coder-480b-a35b-instruct` |
| `AUTHOR_MAX_TOKENS` | same | `16000` (a reply cut off at this limit counts as a failed attempt) |
| `AUTHOR_TEMPERATURE` | same | `0.4` |

Picking a model: list what your account can call with
`curl https://api.fireworks.ai/inference/v1/models -H "Authorization: Bearer $FIREWORKS_API_KEY"` and
use the full `accounts/fireworks/models/<name>` id. Pick a non-thinking instruct model that is
strong at code and fast enough to write a few hundred lines of HTML inside 90 s. Alternatives to
the default (verify the ids in that list): Kimi K2 instruct
(`accounts/fireworks/models/kimi-k2-instruct-0905`) and DeepSeek V3.x
(`accounts/fireworks/models/deepseek-v3p1`). Upstream HTTP errors come back as 502 (or a job
`error`) carrying Fireworks' error body. Fireworks answers 404 "Model not found, inaccessible,
and/or not deployed" for a bad key as well as for a bad model id, so check the key first.

## Runner mode

`AUTHOR_MODE` (`[vars]` in wrangler.toml, default `"direct"`) picks who writes the game. In
`direct` mode the AuthorJob alarm calls Fireworks, as above. In `runner` mode the Worker is only a
queue: `POST /author` stores the job as `queued` and returns `202 { jobId, status: "queued" }`
without starting an alarm or a model call, and a runner on a Mac (the `pi` coding agent in a Docker
sandbox) claims it, reports progress, and completes it. `AUTHOR_FAKE` only affects direct mode's
model call; in runner mode jobs still wait for a runner. `POST /author?wait=1` returns 400 in
runner mode. The TV side is unchanged: poll the public `GET /author/:jobId`, and show its `log`
lines on the "writing your game…" screen.

Runner routes need header `x-publish-token: $PUBLISH_TOKEN` (403 if wrong, 503 if `PUBLISH_TOKEN`
is unset). They all run inside one `AuthorJob` instance named `queue`, one call at a time, so two
claims can never take the same job.

| Route | Body | Answer |
|---|---|---|
| `POST /author/claim` | `{ runner }` | 200 with the oldest `queued` job (by `createdAt`), now `running`, `runner` and `claimedAt` set, `attempt` + 1; 204 when nothing is queued. A job still `running` 8 minutes after its claim is reclaimed (a log line says so); one reclaimed at attempt 3 becomes `error` instead. |
| `POST /author/:jobId/progress` | `{ note, runner? }` | Appends `"<iso time> <note>"` to `log` (last 50 kept), bumps `updatedAt`. |
| `POST /author/:jobId/complete` | `{ id, meta, runner? }` | Bundle already published with `PUT /games/:id`: 409 unless `<id>/meta.json` is in R2; job → `done` with `id` and the stored meta. |
| | `{ id, meta, html, runner? }` | Stores the bundle itself (same checks as `PUT /games/:id`; `meta.id` must equal `id`), job → `done`. |
| | `{ error, runner? }` | Job → `error`. |
| `GET /author/queue` | | `{ counts: { queued, running, done, error }, queued: [{ jobId, createdAt }], running: [{ jobId, runner, claimedAt, attempt }] }` |

`progress` and `complete` answer 409 when the job is not `running`, or when `runner` is given and
the job was claimed by (or reclaimed for) another runner, so a runner that went silent cannot
overwrite its successor. 404 for an unknown job.

A runner-mode job in `jobs/<jobId>.json`:

```json
{
  "jobId": "…12 chars…", "mode": "runner", "status": "queued | running | done | error",
  "prompt": "…", "context": { "…": "from POST /author" },
  "createdAt": "…", "updatedAt": "…", "attempt": 1,
  "runner": "nelsons-mac", "claimedAt": "…",
  "log": ["2026-11-07T10:00:00.000Z sandbox up"],
  "id": "…when done…", "meta": { "…": "when done" }, "error": "…when error…"
}
```

Direct-mode jobs carry `"mode": "direct"` and no `runner`/`claimedAt`/`log`.

| Setting | Where | Notes |
|---|---|---|
| `AUTHOR_MODE` | `[vars]` in wrangler.toml, `--var AUTHOR_MODE:runner`, or `.dev.vars` | `direct` (default) or `runner` |
| `PUBLISH_TOKEN` (secret) | `pnpm exec wrangler secret put PUBLISH_TOKEN`; locally in `.dev.vars` | Guards the runner routes and `PUT /games/:id` |
| `AUTHOR_RECLAIM_MS` | `--var` | Claim timeout before reclaim; default 480000 (8 min). The test sets 2500. |

`test/author.mjs` runs a second `wrangler dev --var AUTHOR_MODE:runner --var PUBLISH_TOKEN:testtoken`
for these routes, including a reclaim.

## The authoring runner (`runner/`)

The Mac side of runner mode. `runner/run.mjs` claims jobs from the queue above, runs the `pi` coding
agent inside a small Docker image to write and test the bundle, re-runs the smoke harness on the
host as the gate, and completes the job with `{ id, meta, html }` (which publishes the bundle) or
`{ error }`.

```sh
cd relay
(cd runner && npm install)          # jsdom for the host-side harness, once
pnpm runner                         # = node runner/run.mjs; Ctrl-C completes the current job as an error
```

The first run builds the image if it is missing (`docker build -t little-redwood-author relay/runner`,
about 20 s, 565 MB: node:22-slim + `@earendil-works/pi-coding-agent@0.80.3` + jsdom, non-root user
`node`, workdir `/job`), and starts Docker Desktop if the daemon is down.

| Flag | Effect |
|---|---|
| `--once` | Handle one job, then exit (status 0 when it published). |
| `--dry` | Skip pi and Docker: the sample bundle is the result. Tests claim → progress → harness → complete. |
| `--local "prompt"` | No relay: author into `runner/jobs/local-<time>/` and stop (nothing is published). |

| Env | Default |
|---|---|
| `RELAY_URL` | `https://little-redwood-relay.nasloon.workers.dev` |
| `PUBLISH_TOKEN` | from `relay/.dev.vars` when unset |
| `FIREWORKS_API_KEY` | from `relay/.dev.vars` when unset; passed to the container as env, never written to disk or baked into the image |
| `AUTHOR_MODEL` | `accounts/fireworks/models/gpt-oss-120b` (only the process env; `.dev.vars`' `AUTHOR_MODEL` is the Worker's) |
| `AUTHOR_THINKING` | `low` |
| `AUTHOR_TIMEOUT_S` | `360` (the container is killed after this; the Worker reclaims at 8 min) |
| `RUNNER` | hostname |
| `AUTHOR_IMAGE` | `little-redwood-author` |

Per job it makes `runner/jobs/<jobId>/` with `TASK.md` (the prompt and context), a `meta.json`
template, `skill/` (`SKILL.md` + `CONTRACT.md`, the bundle contract written for a coding agent),
`harness/smoke.mjs`, and `reference/` (the sample and Who's the Bot, fetched from the relay, local
copies as fallback). Only that directory is mounted, at `/job`; the container gets
`--memory 2g --cpus 2`, default bridge networking (it needs Fireworks), and runs
`pi -p --no-session --offline --no-context-files --skill /job/skill --provider fireworks --model $AUTHOR_MODEL --thinking low "<task>"`.
pi's Fireworks provider is built in, so no models.json is mounted. Progress notes go to the job's
`log` (claimed, agent started, agent working every 30 s, agent finished, harness PASS/FAIL,
publishing); the full transcript is in `runner/logs/<jobId>.log`. On PASS the id is a slug of the
title plus 4 random characters.

### Smoke harness

`node runner/harness/smoke.mjs <bundleDir>` (or `--html … --meta …`) loads `tv.html` into jsdom as the
TV host would: 3 fake players, `init`, then it answers every input screen (first button, short text,
pad strokes), answers `ai` (data from the schema, or text), `bot_answer` (`{ text: "idk lol" }`) and
`ai_image` (a tiny data: PNG), answers `motion_start` with a ready `motion_status` and a few
`motion` frames, and adds a 4th player mid-game. The game clock runs 20x fast (`--speed`). Two passes:
everything answered, then every AI call `ok: false` and the camera `unavailable`. FAIL on: missing
meta fields, external src/href, fetch/XHR/WebSocket/EventSource/import()/storage, no `state` or
`screen` within 5 s of init, uncaught errors, malformed messages or deadlines, no input screen,
stalling before 2 rounds (or `done`), silence after an input. `--verbose` prints every message.
Both `games/sample` and `games/whos-the-bot` pass.

### Player guid

The phone keeps a per-device `guid` in localStorage (`lr.guid`, generated once; session-only if
storage is blocked) and sends it as `&guid=` on every `/join`. The relay keeps it only when it is
8–64 chars of `[A-Za-z0-9-]` (otherwise ignored), stores it on the player record, keeps the original
across rejoin, and includes it in `join`/`rejoin`/`leave`, `room.players` and `GET /rooms/:code`.
A join whose guid already belongs to a connected player in the room is still a new player, marked
`sameDevice: true` (two tabs on one phone). It is a device key, not an account. "Forget me on this
TV" on the join screen clears `lr.guid` and `lr.name.*` and makes a new guid; the Worker-side
`DELETE /memories/:guid` (below) forgets the Worker side.

## Memories

The host's memory book (tv/src/game/memories.ts) posted to the Worker after a game, filed per player
guid and per crew so games and the authoring runner can call back to earlier play (PLAN.md
"Memories"; types `Moment`, `ClipFrame`, `GameResult`, `MemoriesPost`, `MemoriesResponse` in
shared/protocol.ts; code `src/memories.mjs`). CORS `*` like `/games`.

| Route | Body / query | Answer |
|---|---|---|
| `POST /memories` | `{ tvId?, room, hostToken, game, at, moments: Moment[], result?: GameResult, players?: [{ guid, name }] }` | 200 `{ ok, game, moments, clips, players, crew }`. 403 unless `hostToken` is the room's current token (the Room DO answers an internal `/verify-token`); so post before the room closes (60 s after the TV leaves). 400 for a bad code, missing `game`/`at`, non-array `moments`; 413 over 8 MB. Re-posting the same `room`+`at` replaces the game file and does not count twice. |
| `GET /memories?guids=a,b,c` | up to 24 guids | `{ players: { [guid]: { names (≤5, newest first), games, lastSeen, awards: [{ title, game, at }], moments (≤10, no clips), results (≤5) } }, crews: [{ guids, games, moments (≤10) }] }`. Unknown guids are absent. Crews: the full known set and every pair among the first 6 (≤15 pairs), when that exact group has a crew file. |
| `GET /memories/:guid` | | That guid's index (debug); 404 if none. |
| `DELETE /memories/:guid` | | Forget a player (no auth beyond the guid, which is a device secret): deletes the index and every crew file that includes the guid, and scrubs the guid and its parallel display name (and its `scores` entry and `winner`) from the game files and co-players' indexes. 200 `{ ok, deleted: { guid, games, crews, players } }`; 404 if unknown. Free-text titles/captions that mention the name are not rewritten. |

Each moment's `playerGuids` is parallel to `players`; `crew` is the sorted guids of everyone in the
room, `room` the code (the Worker fills both from the post when a moment lacks them). Guids follow
the relay's rule (8 to 64 `[A-Za-z0-9-]`); others are dropped.

R2 layout (bucket `GAMES`):

| Key | Content |
|---|---|
| `memories/game/<room>-<at>.json` | The whole post, cleaned, with every clip kept, plus `players: [{ guid, name }]`. |
| `memories/guid/<guid>.json` | `{ guid, names, games, lastSeen, gameKeys, crewKeys, awards (≤30), moments (≤60, compact, no clips), results (≤30) }`, newest first. A guid gets the moments that name it, plus room-wide moments with no `playerGuids`. |
| `memories/crew/<sha256 hex of sorted guids joined by ",">.json` | `{ guids, games, gameKeys, moments (≤60, compact), results (≤30) }` for rooms of 2 or more. |

Writes are read-modify-write without locks: two posts for the same guid at the same instant can
lose one update.

**Runner injection.** `runner/room-memory.mjs`: when a job's `context.players` is
`[{ id, name, guid? }]`, `run.mjs` adds "Players expected at start" and a "Room memory" block to
TASK.md from `GET /memories?guids=` (2 s timeout, failure means "No history yet: this is their
first game together."). skill/CONTRACT.md "Room memory" tells the agent how to use it.

`test/memories.mjs` (in `pnpm test`) covers auth, the read-back, the crew, the runner block, and a
delete with scrubbing.

## Game scope

Contract: ../PLAN.md "Game scope (built)". Code: `src/games.mjs` (listing, serving, `checkMeta`),
`runner/scope.mjs` (the runner's decision), `scripts/publish-games.mjs` (hand-built stays global).

- `meta.scope`: `"global"` (default when absent) or `"tv"`; with `"tv"`, `meta.tvId` (1–64 chars of
  `[A-Za-z0-9._-]`, required) and `meta.crew` (sorted player guids, ≤ 24, each matching the
  `GUID_RE` in `src/memories.mjs`). `checkMeta` rejects anything else (PUT /games/:id and the runner's
  complete both go through it).
- `GET /games` lists global bundles only. `GET /games?tv=<tvId>` lists global plus that TV's own,
  newest `createdAt` first, compiled-in sample last when it is not in the bucket.
- `GET /games/:id/meta.json` and `/tv.html` for a `"tv"` bundle need `?tv=<its tvId>`; without it or
  with another TV's id they answer 404, the same as an unknown id. Global bundles ignore `?tv=`. An
  invalid `tv` value counts as absent. CORS and `cache-control: no-store` are unchanged.
- The runner sets scope at publish time (`decideScope(job.context, memoryInjected)`): `"tv"` when the
  job's context has a string `tvId`, or TASK.md got a Room memory block with real history (not the
  "No history yet" line), or `context.players` carries valid guids; otherwise `"global"`. `tvId` is
  `context.tvId` (sanitized to the allowed characters if needed), or `"unknown-tv"` when none was sent
  (logged); `crew` is the sorted, deduped guids from `context.players`. Whatever the agent wrote into
  meta.json for these fields is overwritten. The job log shows `publishing <id> (scope tv, crew 3)`.
- `pnpm games:publish` refuses a `games/<id>/meta.json` that declares `scope: "tv"`: hand-built
  bundles are global.
- Tests: `node test/games.mjs` (routes, checkMeta, publish refusal), `node test/scope.mjs` (the
  decision, no relay).

## Look and voice rules

Contract: `runner/skill/SKILL.md` and `runner/skill/CONTRACT.md` "Look and voice rules" (the same
text is in the `/author` system prompt in `src/author.mjs`). Greenlit items 1, 2, 4 and 9 of
`research/design-ideas.md`: one of six named palettes (Noir, Broadcast, Paper, Arcade, Campfire,
Lagoon) declared as `meta.palette` with four tokens at `:root`; three text sizes (`--display`,
`--body`, `--tiny`) and no weight above 500; no emoji as UI; `say` lines of 12 words or fewer.

- The harness (`runner/harness/smoke.mjs`) reads tv.html's CSS (`<style>`, `style="..."`, SVG colour
  attributes) and the `say` lines of each pass. It fails on a purple-family colour (#b98cff #f6f3ff
  #ffd23f #3ddc84 #5fe0c0 within ~24 RGB, any hex length, rgb(), hsl()), a font-weight of 600+,
  more than 2 emoji anywhere in the raw file, a `say` line over 12 words (player names not counted)
  and an unknown `meta.palette`. It warns on more than 6 non-grey colours, more than 3 font sizes
  (selectors/elements with "ring" in the class ignored), radii of 50px+ outside a ring, headings or
  `<b>` left at their default bold, a missing `meta.palette` or tokens, and 2+ exclamation marks in a
  line. Each pass prints `look <pass>: palette, colours, font sizes, max weight, emoji, longest say`.
- Look failures are collected apart from the static checks, so the play-through still runs and the
  report covers the `say` lines too. Since the runner publishes only on PASS, these now gate authored games.
- `games/sample` is restyled to Broadcast (CSS and `meta.palette` only) and passes clean. The runner
  fetches its reference sample from the deployed relay first, so agents see the new sample only
  after `pnpm deploy`.
- `whos-the-bot`, `little-says` and `whodunnit-in-the-room` are unchanged and fail the look checks.
- Test: `node test/look.mjs` (in `pnpm test`, needs jsdom in `runner/node_modules`): the sample passes
  clean, every kit palette passes, and one mutation per check trips it.
