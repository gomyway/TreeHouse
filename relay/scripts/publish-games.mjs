// Publish every pre-built bundle in ../games (a directory holding meta.json and tv.html) to the
// game bucket, so GET /games lists it next to authored games.
//
//   node scripts/publish-games.mjs                 # real bucket (wrangler r2 object put --remote)
//   node scripts/publish-games.mjs --local         # wrangler's local simulation (.wrangler/state)
//   node scripts/publish-games.mjs --local --persist-to DIR
//   node scripts/publish-games.mjs --url http://127.0.0.1:8787   # PUT /games/:id, needs PUBLISH_TOKEN
//   node scripts/publish-games.mjs whos-the-bot    # only the named bundles
//
// meta.json is validated (id = directory name; title, description, phases, minPlayers present);
// createdAt is set from the file's mtime when missing; other fields are kept as written.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gamesDir = path.join(root, "games");
const wrangler = path.join(root, "node_modules/.bin/wrangler");
const BUCKET = "little-redwood-games";

const args = process.argv.slice(2);
const opt = { local: false, persistTo: null, url: null, only: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--local") opt.local = true;
  else if (a === "--persist-to") opt.persistTo = args[++i];
  else if (a === "--url") opt.url = args[++i]?.replace(/\/$/, "");
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
    const metaPath = path.join(gamesDir, id, "meta.json"), tvPath = path.join(gamesDir, id, "tv.html");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const errors = checkMeta(meta, id);
      if (errors.length) throw new Error(errors.join("; "));
      if (!meta.createdAt) meta.createdAt = fs.statSync(metaPath).mtime.toISOString();
      const html = fs.readFileSync(tvPath, "utf8");
      if (!html.trim()) throw new Error("tv.html is empty");
      if (opt.url) {
        const res = await fetch(`${opt.url}/games/${id}`, {
          method: "PUT", headers: { "content-type": "application/json", "x-publish-token": process.env.PUBLISH_TOKEN },
          body: JSON.stringify({ meta, html }),
        });
        if (!res.ok) throw new Error(`PUT /games/${id} ${res.status} ${await res.text()}`);
      } else {
        const out = path.join(tmp, `${id}.meta.json`);
        fs.writeFileSync(out, JSON.stringify(meta));
        put(`${id}/tv.html`, tvPath, "text/html; charset=utf-8"); // tv.html first: a listed meta always has its html
        put(`${id}/meta.json`, out, "application/json");
      }
      published++;
      console.log(`published ${id}  "${meta.title}"  createdAt ${meta.createdAt}`);
    } catch (err) {
      failed++;
      console.error(`FAILED ${id}: ${err.message}`);
    }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`${published} published, ${failed} failed`);
process.exit(failed ? 1 : 0);
