// Publish every pre-built bundle in ../games (a directory holding meta.json and tv.html, plus lobby.html
// when the game ships a lobby card) to the game bucket, so GET /games lists it next to authored games.
//
//   node scripts/publish-games.mjs                 # real bucket (wrangler r2 object put --remote)
//   node scripts/publish-games.mjs --local         # wrangler's local simulation (.wrangler/state)
//   node scripts/publish-games.mjs --local --persist-to DIR
//   node scripts/publish-games.mjs --url http://127.0.0.1:8787   # PUT /games/:id, needs PUBLISH_TOKEN
//   node scripts/publish-games.mjs whos-the-bot    # only the named bundles
//   node scripts/publish-games.mjs --force         # publish even when the static gate fails
//
// meta.json is validated (id = directory name; title, description, phases, minPlayers present);
// createdAt is set from the file's mtime when missing; meta.lobby is set from whether lobby.html exists;
// other fields are kept as written. The smoke harness is not run here; the static pre-save gate
// (src/gate.mjs, the same one the Worker runs) is: its warns are printed, its fails refuse the bundle
// unless --force.
// Hand-built bundles are global (PLAN.md "Game scope"): a meta declaring scope "tv" is refused.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { staticGate } from "../src/gate.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gamesDir = path.join(root, "games");
const wrangler = path.join(root, "node_modules/.bin/wrangler");
const BUCKET = "little-redwood-games";
const MAX_PLAYERS = 16; // same as src/games.mjs; a hand-built maxPlayers above it is clamped (and logged), not refused

const args = process.argv.slice(2);
const opt = { local: false, persistTo: null, url: null, only: [], force: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--local") opt.local = true;
  else if (a === "--persist-to") opt.persistTo = args[++i];
  else if (a === "--url") opt.url = args[++i]?.replace(/\/$/, "");
  else if (a === "--force") opt.force = true;
  else if (a.startsWith("-")) { console.error(`unknown flag ${a}`); process.exit(2); }
  else opt.only.push(a);
}
if (opt.url && !process.env.PUBLISH_TOKEN) { console.error("--url needs PUBLISH_TOKEN in the environment"); process.exit(2); }

function checkMeta(meta, id) { // same rules as checkMeta in src/games.mjs
  const e = [];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return ["meta must be an object"];
  if (meta.id !== id) e.push(`meta.id ${JSON.stringify(meta.id)} must equal the directory name ${JSON.stringify(id)}`);
  for (const k of ["title", "description"]) if (typeof meta[k] !== "string" || !meta[k].trim()) e.push(`${k} missing`);
  if (!Array.isArray(meta.phases) || !meta.phases.length) e.push("phases missing");
  if (!Number.isInteger(meta.minPlayers) || meta.minPlayers < 1) e.push("minPlayers missing");
  if (!Number.isInteger(meta.maxPlayers) || meta.maxPlayers < meta.minPlayers) e.push(`maxPlayers must be an integer >= minPlayers (and <= ${MAX_PLAYERS})`);
  if (meta.scope === "tv") e.push(`scope "tv" is for authored games seeded with Room memory; hand-built bundles are global (remove scope/tvId/crew from games/${id}/meta.json)`);
  else if (meta.scope !== undefined && meta.scope !== "global") e.push(`scope ${JSON.stringify(meta.scope)} must be "global" (or absent)`);
  return e;
}

function put(key, file, contentType) {
  const where = opt.local ? ["--local", ...(opt.persistTo ? ["--persist-to", opt.persistTo] : [])] : ["--remote"];
  const r = spawnSync(wrangler, ["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", contentType, ...where],
    { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`wrangler r2 object put ${key} exited ${r.status ?? r.signal}`);
}

const dirs = fs.readdirSync(gamesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  .filter((id) => fs.existsSync(path.join(gamesDir, id, "meta.json")) && fs.existsSync(path.join(gamesDir, id, "tv.html")))
  .filter((id) => !opt.only.length || opt.only.includes(id));
for (const id of opt.only) if (!dirs.includes(id)) { console.error(`no bundle games/${id}/{meta.json,tv.html}`); process.exit(1); }

const target = opt.url ?? (opt.local ? `local R2 (${opt.persistTo ?? ".wrangler/state"})` : `R2 ${BUCKET} (remote)`);
console.log(`publishing ${dirs.length} bundle(s) to ${target}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "publish-games-"));
let published = 0, failed = 0;
try {
  for (const id of dirs) {
    const metaPath = path.join(gamesDir, id, "meta.json"), tvPath = path.join(gamesDir, id, "tv.html"), lobbyPath = path.join(gamesDir, id, "lobby.html");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const errors = checkMeta(meta, id);
      if (errors.length) throw new Error(errors.join("; "));
      if (!meta.createdAt) meta.createdAt = fs.statSync(metaPath).mtime.toISOString();
      if (meta.maxPlayers > MAX_PLAYERS) { console.log(`${id}: maxPlayers ${meta.maxPlayers} clamped to ${MAX_PLAYERS}`); meta.maxPlayers = MAX_PLAYERS; }
      const html = fs.readFileSync(tvPath, "utf8");
      if (!html.trim()) throw new Error("tv.html is empty");
      const lobby = fs.existsSync(lobbyPath) ? fs.readFileSync(lobbyPath, "utf8") : null;
      if (lobby !== null && !lobby.trim()) throw new Error("lobby.html is empty");
      meta.lobby = lobby !== null;
      const g = staticGate({ html, meta, lobby });
      for (const w of g.warns) console.log(`${id}: gate warn ${w.code}: ${w.msg}`);
      for (const f of g.fails) console.error(`${id}: gate FAIL ${f.code}: ${f.msg}`);
      if (g.fails.length && !opt.force) throw new Error(`static gate: ${g.fails.length} fail(s) (${g.fails.map((f) => f.code).join(", ")}); fix them or pass --force`);
      if (opt.url) {
        const res = await fetch(`${opt.url}/games/${id}`, {
          method: "PUT", headers: { "content-type": "application/json", "x-publish-token": process.env.PUBLISH_TOKEN },
          body: JSON.stringify({ meta, html, ...(lobby !== null ? { lobby } : {}) }),
        });
        if (!res.ok) throw new Error(`PUT /games/${id} ${res.status} ${await res.text()}`);
      } else {
        const out = path.join(tmp, `${id}.meta.json`);
        fs.writeFileSync(out, JSON.stringify(meta));
        put(`${id}/tv.html`, tvPath, "text/html; charset=utf-8"); // tv.html (and lobby.html) first: a listed meta always has its html
        if (lobby !== null) put(`${id}/lobby.html`, lobbyPath, "text/html; charset=utf-8");
        put(`${id}/meta.json`, out, "application/json");
      }
      published++;
      console.log(`published ${id}  "${meta.title}"  createdAt ${meta.createdAt}  lobby ${meta.lobby ? "yes" : "no"}`);
    } catch (err) {
      failed++;
      console.error(`FAILED ${id}: ${err.message}`);
    }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`${published} published, ${failed} failed`);
process.exit(failed ? 1 : 0);
