// GET /games lists the bucket itself, against `wrangler dev --var AUTHOR_FAKE:1 --var PUBLISH_TOKEN:…`:
// an empty bucket lists only the compiled-in sample; an authored bundle comes before it; pre-built
// bundles published with PUT /games/:id (and with scripts/publish-games.mjs --url) are listed by
// createdAt and served; PUT needs the token. Local R2 state goes to a fresh temp dir.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const relayDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = path.join(relayDir, "node_modules/.bin/wrangler");
const TOKEN = "test-publish-token";

const port = 20000 + Math.floor(Math.random() * 1000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-games-"));
const logPath = path.join(tmp, "wrangler.log");
const logFd = fs.openSync(logPath, "w"); // never leave a child pipe undrained: it blocks the child
const child = spawn(wranglerBin, ["dev", "--port", String(port), "--var", "AUTHOR_FAKE:1", "--var", `PUBLISH_TOKEN:${TOKEN}`,
  "--persist-to", path.join(tmp, "state")], { cwd: relayDir, stdio: ["ignore", logFd, logFd] });
process.on("exit", (code) => {
  child.kill();
  if (code) console.error(`wrangler log (${logPath}):\n` + fs.readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n"));
  else fs.rmSync(tmp, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${port}`;
for (const started = Date.now(); ;) {
  if (Date.now() - started > 90_000) { console.error("wrangler dev did not start in 90 s"); process.exit(1); }
  try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const get = (p, init) => fetch(base + p, init);
const ids = async () => {
  const res = await get("/games");
  if (!res.ok || res.headers.get("access-control-allow-origin") !== "*") fail(`GET /games ${res.status}`);
  return (await res.json()).map((m) => m.id);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const put = (id, body, token = TOKEN) => get(`/games/${id}`, {
  method: "PUT", headers: { "content-type": "application/json", ...(token ? { "x-publish-token": token } : {}) }, body: JSON.stringify(body),
});

let list = await ids();
if (!same(list, ["sample"])) fail(`empty bucket lists ${list}`); ok("empty bucket: GET /games lists only the compiled-in sample");

let res = await get("/author?wait=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "authored one" }) });
const authored = await res.json();
if (res.status !== 200 || !authored.id) fail(`POST /author ${res.status} ${JSON.stringify(authored)}`);
list = await ids();
if (!same(list, [authored.id, "sample"])) fail(`after author: ${list}`); ok("authored bundle is listed before the sample");

const html = "<!doctype html><title>prebuilt</title><script>parent.postMessage({type:'done'},'*')</script>";
const meta = (id, extra = {}) => ({ id, title: `Pre-built ${id}`, description: "test bundle", phases: ["one"], minPlayers: 2, maxPlayers: 6, ...extra });

if ((await put("prebuilt-old", { meta: meta("prebuilt-old"), html }, null)).status !== 403) fail("PUT without token should 403");
if ((await put("prebuilt-old", { meta: meta("prebuilt-old"), html }, "wrong")).status !== 403) fail("PUT with wrong token should 403");
ok("PUT /games/:id without the publish token → 403");
if ((await put("prebuilt-old", { meta: meta("other-id"), html })).status !== 400) fail("PUT with mismatched id should 400");
if ((await put("prebuilt-old", { meta: { id: "prebuilt-old", title: "x" }, html })).status !== 400) fail("PUT with incomplete meta should 400");
if ((await put("prebuilt-old", { meta: meta("prebuilt-old") })).status !== 400) fail("PUT without html should 400");
ok("PUT /games/:id rejects a mismatched id, incomplete meta, missing html → 400");

res = await put("prebuilt-old", { meta: meta("prebuilt-old", { createdAt: "2000-01-01T00:00:00.000Z", extra: "kept" }), html });
if (res.status !== 200) fail(`PUT prebuilt-old ${res.status} ${await res.text()}`);
list = await ids();
if (!same(list, [authored.id, "prebuilt-old", "sample"])) fail(`after old prebuilt: ${list}`);
ok("pre-built bundle with an old createdAt sorts after the authored one; compiled-in sample stays last");

res = await put("prebuilt-new", { meta: meta("prebuilt-new"), html }); // no createdAt → now
const stored = await res.json();
if (res.status !== 200 || !stored.meta?.createdAt) fail(`PUT prebuilt-new ${res.status} ${JSON.stringify(stored)}`);
list = await ids();
if (!same(list, ["prebuilt-new", authored.id, "prebuilt-old", "sample"])) fail(`after new prebuilt: ${list}`);
ok("pre-built bundle without createdAt gets now and is listed first");

res = await get("/games/prebuilt-old/meta.json");
const m = await res.json();
if (res.status !== 200 || m.title !== "Pre-built prebuilt-old" || m.extra !== "kept" || res.headers.get("access-control-allow-origin") !== "*") fail(`meta ${res.status} ${JSON.stringify(m)}`);
res = await get("/games/prebuilt-old/tv.html");
if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("text/html") || !res.headers.get("content-security-policy") || (await res.text()) !== html)
  fail(`tv.html ${res.status}`);
ok("pre-built bundle is served at /games/:id/meta.json (extra fields kept) and /games/:id/tv.html");

// The publish script's HTTP path, on the repo's sample bundle: once the bucket holds sample/meta.json
// it is listed once, by its createdAt, instead of being forced last.
const pub = spawnSync(process.execPath, [path.join(relayDir, "scripts/publish-games.mjs"), "--url", base, "sample"],
  { env: { ...process.env, PUBLISH_TOKEN: TOKEN }, encoding: "utf8" });
if (pub.status !== 0 || !/1 published, 0 failed/.test(pub.stdout)) fail(`publish-games --url: ${pub.status}\n${pub.stdout}${pub.stderr}`);
const sampleMeta = JSON.parse(fs.readFileSync(path.join(relayDir, "games/sample/meta.json"), "utf8"));
list = await ids();
const expected = [{ id: "prebuilt-new", t: stored.meta.createdAt }, { id: authored.id, t: authored.meta.createdAt },
  { id: "prebuilt-old", t: "2000-01-01T00:00:00.000Z" }, { id: "sample", t: sampleMeta.createdAt }]
  .sort((a, b) => Date.parse(b.t) - Date.parse(a.t)).map((x) => x.id);
if (!same(list, expected)) fail(`after publishing sample: ${list}, expected ${expected}`);
ok(`scripts/publish-games.mjs --url publishes the sample; listed once, by createdAt (${list.join(", ")})`);

if ((await get("/games/nope1234/meta.json")).status !== 404) fail("unknown id should 404"); ok("unknown game → 404");

console.log(`\n${n} checks passed`); process.exit(0);
