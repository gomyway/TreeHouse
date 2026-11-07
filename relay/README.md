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
