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
| `ANTHROPIC_API_KEY` | `pnpm exec wrangler secret put ANTHROPIC_API_KEY`; locally in `.dev.vars` (gitignored) | Key for live authoring |
| `AUTHOR_MODEL` | var | Model id, default `claude-opus-5-5` |
| `AUTHOR_FAKE` | var (`.dev.vars`, or `--var AUTHOR_FAKE:1`) | Skip the API; store the sample bundle under a new id (after 300 ms) |

Live requests use the Anthropic TypeScript SDK (it runs on Workers), streaming with adaptive thinking,
`max_tokens` 32000, and the system prompt cached. On the Opus 5.5 / Opus 5 / Sonnet 5.5 / Fable 5.1 models the request also
opts into server-side refusal fallback (`fallbacks: "default"`); a refusal that still comes back is a 502.

## Deploy

```sh
pnpm exec wrangler r2 bucket create little-redwood-games   # once
pnpm exec wrangler secret put ANTHROPIC_API_KEY            # once
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
