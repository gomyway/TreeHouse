# AGENTS.md — Little Redwood

This is a **Little app**: a normal website that the Little television opens in its own
window and drives by voice through `@kabletv/little-sdk`. Scaffolded by `little init`
(template: react).

## The mental model (three planes)

- **Perception (app → agent):** the agent *sees* the page through `data-little-*`
  attributes on the DOM you already render. `data-little` is one of
  `region | item | control | readout`; `data-little-label` is what it's called,
  `data-little-data` (valid JSON) is what it holds, `data-little-action` names the tool
  activating it runs, `data-little-id` is a stable opaque id.
- **Actuation (agent → app):** the agent *drives* the page by calling **tools**. Every
  tool is declared in `public/little/manifest.json` (`name`, model-facing
  `description`, `authority`, JSON-Schema `params`) AND registered in code with a
  handler. A handler returns `{ detail, say? }` — `say` is a line for the television to
  speak.
- **Events (app → agent):** `app.emit(name, data)` for things the viewer did that the
  agent can't see.

## Files

- `public/little/manifest.json` — the contract the platform pins on publish: routing copy
  (`description` — *when* to launch this app), `tools[]`, optional `launchSchema`
  (the params `onEnter` receives — a strict JSON Schema whose `description`s are what
  the model reads; no schema means no params), `capabilities[]`, `content[]`,
  `guide`, and optional `answers` (queries for answers on screen, actions a background
  task calls on your server while the app is closed). Served at `/little/manifest.json`.
- `src/App.tsx` — `useLittleTool(name, handler)` from `@kabletv/little-react` per manifest tool (StrictMode-safe; the hook owns the one page connection).
- `little.config.json` — how `little dev` runs this project (`appUrl`, `manifest`,
  `dev` command). `little.json` (if present) binds the directory to a publisher org.
- `vite.config.ts` — keep `base: "./"`: a published app loads from a CDN prefix, and
  root-absolute asset URLs 404 there.

## The loop (the `little` CLI)

```bash
little dev                 # run the app inside the real device harness + debug panel (starts the dev server for you)
little manifest validate   # offline shape check + the server's authoritative verdict
little publish --url <origin>  # fetch → sanitize → pin the manifest into the catalog
little doctor              # when anything is off: Node, JDK, auth, registry, manifest
```

While `little dev` is running, a second terminal drives it — this is how YOU verify a
change without a human looking at the window:

```bash
little dev snapshot --json           # the referent map the agent sees right now (prompt + referents)
little dev call <tool> '{"id":"…"}'  # fire a declared tool as the agent would; prints the app's ack
little dev events --follow           # the live feed: status, spoken lines, tool calls, results, referent maps
little dev say "…"                   # one viewer turn through the agent (when the agent line is live)
little dev actions --json            # your actions, or one called as Little would (sandbox: your verifier needs allowSandbox)
```

If your editor runs MCP servers, `.cursor/mcp.json` and `.mcp.json` already start
`little mcp`: the same loop as native tools (`status`, `snapshot`, `call_tool`, `say`,
`events`), plus `screenshot` and `press` (the remote) for the ten-foot UI, and
`search_docs` / `read_doc`. Prefer those tools to shelling out when they are present.

Every command takes `--json` (the result document on stdout, all chrome on stderr) —
prefer it when you are the one reading the output. `little <command> --help` is exact.
Installing needs `NODE_AUTH_TOKEN` (a GitHub token with `read:packages`) because the
`@kabletv` packages are private for now; `.npmrc` is already wired.

## Rules that are cheap to break

- A tool's `name` in the manifest, its handler registration, and any
  `data-little-action` must match exactly — and no single check sees all three.
  `little manifest validate` checks only the manifest (shape + the server's publish
  verdict). The inspector's `validate()` / `validateDom(manifest)` flags a
  `data-little-action` that names no manifest tool. Nothing static checks that a declared
  tool has a handler: fire each tool with `little dev call <tool>` (or in the panel, or
  `dispatchToDom` in a test). A declared tool with no handler still works if an element carries a matching
  `data-little-action` (default actuation clicks it); with neither, the agent's call fails.
- A tool that takes arguments MUST declare `params`, or the model calls it with none.
  Likewise an app that takes launch params MUST declare `launchSchema` (root
  `type: "object"`, `additionalProperties: false`); without it the host accepts only
  `{}`. Put the model's guidance in each property's `description`.
- `authority`: `read` (free) · `mutate` (reversible) · `consequential` (payments,
  identity, posting — platform-confirmed). Never mark a mutation `read`.
- `description` fields are **written for the model**: say when to launch / when to call,
  not what the code does.
- Use `readout` for text the agent should read but not select (a total, a display);
  `item` implies selectable. Opaque ids; labels carry the meaning.
- Before adding a host capability (voice, camera, sign-in, purchase, the asset library),
  declare it in `capabilities[]` and gate the call on `app.can(name)`.

## Read next

- Docs: https://docs.little.co/docs — quickstart, authoring guide, manifest reference, capabilities,
  CLI. Agent index: https://docs.little.co/llms.txt (full text: https://docs.little.co/llms-full.txt).
- The portable A-Z skill (one file, the whole path): https://developers.little.co/skill/SKILL.md —
  drop it in `.cursor/skills/little-app/SKILL.md` or `.claude/skills/`.
- CLI guide + command reference: https://docs.little.co/docs/cli
