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
const child = spawn(wranglerBin, ["dev", "--port", String(port), "--var", "AUTHOR_FAKE:1", "--var", "AUTHOR_MODE:direct", "--var", `PUBLISH_TOKEN:${TOKEN}`,
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
const sampleLobby = fs.readFileSync(path.join(relayDir, "games/sample/lobby.html"), "utf8");
let entry = (await get("/games").then((r) => r.json()))[0];
let res = await get("/games/sample/lobby.html");
if (entry.lobby !== true || res.status !== 200 || !res.headers.get("content-security-policy") || (await res.text()) !== sampleLobby) fail(`compiled-in sample lobby ${entry.lobby} ${res.status}`);
ok("empty bucket: the compiled-in sample lists lobby:true and serves /games/sample/lobby.html");

res = await get("/author?wait=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "authored one" }) });
const authored = await res.json();
if (res.status !== 200 || !authored.id) fail(`POST /author ${res.status} ${JSON.stringify(authored)}`);
list = await ids();
if (!same(list, [authored.id, "sample"])) fail(`after author: ${list}`); ok("authored bundle is listed before the sample");

const html = "<!doctype html><title>prebuilt</title><script>parent.postMessage({type:'done'},'*')</script>";
const lobbyHtml = "<!doctype html><title>card</title><style>@keyframes s{to{opacity:.5}} p{animation:s 2s infinite}</style><p>card</p><script>parent.postMessage({type:'lobby_ready'},'*')</script>";
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

// Game scope (PLAN.md "Game scope"): a tv-scoped bundle is listed and served only with ?tv=<its tvId>.
const before = list; // the listing after publishing the sample (by createdAt; the bucket's sample sorts by date now)
const idsFor = async (q) => {
  const r = await get(`/games${q}`);
  if (!r.ok || r.headers.get("access-control-allow-origin") !== "*" || r.headers.get("cache-control") !== "no-store") fail(`GET /games${q} ${r.status}`);
  return (await r.json()).map((m) => m.id);
};
const bad = async (extra, why) => {
  const r = await put("scoped-bad", { meta: meta("scoped-bad", extra), html });
  if (r.status !== 400) fail(`PUT with ${why} should 400, got ${r.status}`);
};
await bad({ scope: "household" }, 'scope "household"');
await bad({ scope: "tv", tvId: "has space" }, "a bad tvId");
await bad({ scope: "tv", tvId: "x".repeat(65) }, "a 65-char tvId");
await bad({ scope: "tv", tvId: "tv-test-1", crew: "guid-a-0001" }, "crew not an array");
await bad({ scope: "tv", tvId: "tv-test-1", crew: ["no"] }, "a crew entry that is not a guid");
ok('checkMeta rejects scope "household", a bad tvId, and a bad crew → 400');

res = await put("scoped-tv", { meta: meta("scoped-tv", { scope: "tv", tvId: "tv-test-1", crew: ["guid-a-0001"] }), html, lobby: lobbyHtml });
if (res.status !== 200) fail(`PUT scoped-tv ${res.status} ${await res.text()}`);
res = await put("scoped-global", { meta: meta("scoped-global", { scope: "global" }), html });
if (res.status !== 200) fail(`PUT scoped-global ${res.status} ${await res.text()}`);
ok("PUT a tv-scoped bundle (tv-test-1, crew 1) and an explicit global one");

list = await idsFor("");
if (!same(list, ["scoped-global", ...before])) fail(`GET /games: ${list}`);
ok("GET /games omits the tv-scoped bundle; global ones (explicit and absent scope) listed as before");
list = await idsFor("?tv=tv-test-1");
if (!same(list, ["scoped-global", "scoped-tv", ...before])) fail(`GET /games?tv=tv-test-1: ${list}`);
ok(`GET /games?tv=tv-test-1 adds it, newest first (${list.join(", ")})`);
list = await idsFor("?tv=tv-other");
if (!same(list, ["scoped-global", ...before])) fail(`GET /games?tv=tv-other: ${list}`);
ok("GET /games?tv=<another tv> omits it");

for (const f of ["tv.html", "meta.json", "lobby.html"]) {
  const st = async (q) => (await get(`/games/scoped-tv/${f}${q}`)).status;
  const [none, mine, other] = [await st(""), await st("?tv=tv-test-1"), await st("?tv=tv-other")];
  if (none !== 404 || mine !== 200 || other !== 404) fail(`${f}: no tv ${none}, right tv ${mine}, other tv ${other}`);
}
res = await get("/games/scoped-tv/tv.html?tv=tv-test-1");
if (res.headers.get("access-control-allow-origin") !== "*" || !res.headers.get("content-security-policy") || (await res.text()) !== html) fail("scoped tv.html headers/body");
if ((await get("/games?tv=tv-test-1").then((r) => r.json())).find((m) => m.id === "scoped-tv")?.lobby !== true) fail("scoped-tv lobby flag");
ok("GET /games/scoped-tv/{tv.html,meta.json,lobby.html}: 404 without tv, 200 with tv-test-1, 404 with another tv; listed with lobby:true");
for (const q of ["", "?tv=tv-test-1", "?tv=tv-other"]) {
  if ((await get(`/games/scoped-global/tv.html${q}`)).status !== 200 || (await get(`/games/sample/meta.json${q}`)).status !== 200) fail(`global bundle with "${q}"`);
}
ok("global bundles are served with or without ?tv=");

// scripts/publish-games.mjs refuses a hand-built meta declaring scope "tv" (copy of the script on a temp games dir).
const pubRoot = path.join(tmp, "pubroot");
fs.mkdirSync(path.join(pubRoot, "scripts"), { recursive: true });
fs.copyFileSync(path.join(relayDir, "scripts/publish-games.mjs"), path.join(pubRoot, "scripts/publish-games.mjs"));
for (const [id, extra] of [["hand-tv", { scope: "tv", tvId: "tv-test-1" }], ["hand-ok", {}], ["hand-big", { maxPlayers: 40 }]]) {
  fs.mkdirSync(path.join(pubRoot, "games", id), { recursive: true });
  fs.writeFileSync(path.join(pubRoot, "games", id, "meta.json"), JSON.stringify(meta(id, extra)));
  fs.writeFileSync(path.join(pubRoot, "games", id, "tv.html"), html);
}
const pub2 = spawnSync(process.execPath, [path.join(pubRoot, "scripts/publish-games.mjs"), "--url", base],
  { env: { ...process.env, PUBLISH_TOKEN: TOKEN }, encoding: "utf8" });
if (pub2.status === 0 || !/2 published, 1 failed/.test(pub2.stdout) || !/hand-big: maxPlayers 40 clamped to 16/.test(pub2.stdout) || !/FAILED hand-tv: .*hand-built bundles are global/.test(pub2.stderr)) fail(`publish-games scope tv: ${pub2.status}\n${pub2.stdout}${pub2.stderr}`);
if ((await idsFor("?tv=tv-test-1")).includes("hand-tv")) fail("hand-tv was published");
if ((await get("/games/hand-big/meta.json").then((r) => r.json())).maxPlayers !== 16) fail("hand-big maxPlayers not clamped");
ok("scripts/publish-games.mjs refuses a hand-built meta with scope \"tv\", clamps maxPlayers 40 to 16 (logged), and publishes the rest");

// Lobby card (PLAN.md "Lobby card").
const listed = async (id) => (await get("/games").then((r) => r.json())).find((m) => m.id === id);
res = await put("with-lobby", { meta: meta("with-lobby", { lobby: false }), html, lobby: lobbyHtml });
const wl = await res.json();
if (res.status !== 200 || wl.meta?.lobby !== true) fail(`PUT with lobby ${res.status} ${JSON.stringify(wl)}`);
if ((await listed("with-lobby"))?.lobby !== true) fail("with-lobby not listed with lobby:true");
res = await get("/games/with-lobby/lobby.html");
if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("text/html") || !res.headers.get("content-security-policy") || res.headers.get("access-control-allow-origin") !== "*" || (await res.text()) !== lobbyHtml)
  fail(`with-lobby lobby.html ${res.status}`);
if ((await get("/games/with-lobby/meta.json").then((r) => r.json())).lobby !== true) fail("meta.json lobby flag");
ok("PUT /games/:id with lobby → meta.lobby true (whatever the meta said), listed lobby:true, GET /games/:id/lobby.html serves it with the CSP");
if ((await listed("prebuilt-old"))?.lobby !== false || (await get("/games/prebuilt-old/lobby.html")).status !== 404) fail("bundle without lobby");
res = await put("no-lobby", { meta: meta("no-lobby", { lobby: true }), html });
if ((await res.json()).meta?.lobby !== false || (await listed("no-lobby"))?.lobby !== false || (await get("/games/no-lobby/lobby.html")).status !== 404) fail("no-lobby claiming lobby:true");
ok("a bundle without a lobby card → lobby:false (even if its meta claimed true) and lobby.html 404");
res = await put("with-lobby", { meta: meta("with-lobby"), html });
if (res.status !== 200 || (await listed("with-lobby"))?.lobby !== false || (await get("/games/with-lobby/lobby.html")).status !== 404) fail("republish without lobby");
ok("republishing without lobby removes the card: lobby:false, lobby.html 404");
for (const [lobby, why, re] of [
  ["<p>no document</p>", "not html", /not an html document/],
  ['<!doctype html><script src="https://cdn.example/x.js"></script>', "script src", /script src/],
  ['<!doctype html><style>@import url("https://x.example/a.css");</style>', "@import", /external resource/],
  ["<!doctype html><script>fetch('/x')</script>", "fetch", /network/],
  ["<!doctype html>" + "x".repeat(300 * 1024), "too big", /cap is 256 KB/],
  ["", "empty", /non-empty/],
]) {
  res = await put("bad-lobby", { meta: meta("bad-lobby"), html, lobby });
  const b = await res.json();
  if (res.status !== 400 || !re.test(b.error)) fail(`PUT with a lobby that is ${why}: ${res.status} ${JSON.stringify(b).slice(0, 200)}`);
}
if ((await get("/games/bad-lobby/meta.json")).status !== 404) fail("bad-lobby was stored");
ok("PUT rejects a lobby that is not html, loads a script/@import from the network, fetches, is over 256 KB or empty → 400");
for (const [extra, why] of [[{ maxPlayers: 17 }, "maxPlayers 17"], [{ maxPlayers: undefined }, "no maxPlayers"], [{ minPlayers: 4, maxPlayers: 3 }, "max < min"], [{ maxPlayers: 8.5 }, "maxPlayers 8.5"]]) {
  res = await put("bad-max", { meta: meta("bad-max", extra), html });
  if (res.status !== 400 || !/maxPlayers must be an integer with minPlayers <= maxPlayers <= 16/.test((await res.json()).error)) fail(`PUT with ${why} should 400`);
}
if ((await put("max-16", { meta: meta("max-16", { maxPlayers: 16 }), html })).status !== 200) fail("maxPlayers 16 should publish");
ok("checkMeta: maxPlayers must be an integer with minPlayers <= maxPlayers <= 16 (17, missing, below min, 8.5 → 400; 16 → 200)");
// The publish script uploads lobby.html when the folder has one (the sample was published above).
if ((await listed("sample"))?.lobby !== true || (await get("/games/sample/lobby.html").then((r) => r.text())) !== sampleLobby) fail("published sample lobby");
ok("scripts/publish-games.mjs --url uploaded the sample's lobby.html; listed lobby:true");

console.log(`\n${n} checks passed`); process.exit(0);
