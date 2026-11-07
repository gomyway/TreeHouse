# relay

One Cloudflare Worker, three route families (PLAN.md, "Three public addresses"):

| Routes | What | Code |
|---|---|---|
| `wss://…/host`, `wss://…/join?code=`, `GET /rooms/:code`, `GET /health` | Relay: one Durable Object per room routes frames between the TV and phones. The phone shell (`../phone`) is served as static assets from `/`. | `src/worker.mjs` |
| `GET /games`, `GET /games/:id/meta.json`, `GET /games/:id/tv.html` | Game storage on R2 (binding `GAMES`, bucket `little-redwood-games`). `/games` lists every meta, newest first, with the built-in sample last. | `src/games.mjs` |
| `POST /author` `{ prompt, context? }` → `{ id, meta }` | Authoring manager: Claude writes a game bundle, the Worker validates it (one retry with the errors fed back) and stores it under a new 8-letter id. 400 for a missing prompt, 502 with the error text when generation fails or runs past 90 s. | `src/author.mjs` |

`/games` and `/author` answer CORS with `access-control-allow-origin: *` (OPTIONS preflight → 204), because the TV app runs on another origin.

## Local run

```sh
pnpm install
cp .dev.vars.example .dev.vars     # AUTHOR_FAKE=1: /author returns the sample, no key needed
pnpm dev                           # wrangler dev on :8787; R2 is simulated under .wrangler/
pnpm test                          # test/e2e.mjs (relay) then test/author.mjs (games + author)
```

`test/author.mjs` starts its own `wrangler dev --var AUTHOR_FAKE:1` with local state in a temp dir.

## Secrets and settings

| Name | Where | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | `pnpm exec wrangler secret put ANTHROPIC_API_KEY`; locally in `.dev.vars` (gitignored) | Key for live authoring |
| `AUTHOR_MODEL` | var | Model id, default `claude-opus-5-5` |
| `AUTHOR_FAKE` | var (`.dev.vars`, or `--var AUTHOR_FAKE:1`) | Skip the API; store the sample bundle under a new id |

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

1. `POST /author { "prompt": "a two-phase quiz where…" }` → `{ id, meta }` (or skip and use `sample`).
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
