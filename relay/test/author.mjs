// Game storage + authoring manager against `wrangler dev --var AUTHOR_FAKE:1` (no API key needed):
// the sample bundle is served from an empty bucket, POST /author?wait=1 stores a new bundle that the
// TV can then pull, the listing puts it first, CORS preflight works, and async POST /author returns a
// job that polling GET /author/:jobId follows to done. Then a second `wrangler dev` in runner mode
// (AUTHOR_MODE:runner, PUBLISH_TOKEN:testtoken) checks the queue: claim, progress, complete, reclaim.
// Local R2 state goes to a fresh temp dir so runs don't see each other. Targets RELAY_HTTP
// (http://host:port) for the direct section when set, and RELAY_RUNNER_HTTP for the runner section.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const wranglerBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/wrangler");

// Starts `wrangler dev` with these --var flags and local state in a fresh temp dir; returns { base, child }.
const tmps = [];
async function start(vars) {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-author-"));
  tmps.push(tmp);
  const logPath = path.join(tmp, "wrangler.log");
  const logFd = fs.openSync(logPath, "w"); // never leave a child pipe undrained: it blocks the child
  const proc = spawn(wranglerBin, ["dev", "--port", String(port), ...vars.flatMap((v) => ["--var", v]), "--persist-to", path.join(tmp, "state")],
    { stdio: ["ignore", logFd, logFd] });
  lastLog = logPath;
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 90_000) { console.error("wrangler dev did not start in 90 s"); proc.kill(); process.exit(1); }
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return { base: `http://127.0.0.1:${port}`, child: proc };
}
let lastLog = null;
process.on("exit", (code) => {
  if (code && lastLog) console.error(`wrangler log (${lastLog}):\n` + fs.readFileSync(lastLog, "utf8").split("\n").slice(-30).join("\n"));
  else for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
});

let base = process.env.RELAY_HTTP, child = null;
if (!base) ({ base, child } = await start(["AUTHOR_FAKE:1", "AUTHOR_MODE:direct", "PUBLISH_TOKEN:"]));
const done = (code) => { child?.kill(); process.exit(code); };
const fail = (m) => { console.error("FAIL:", m); done(1); };
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const get = (p, init) => fetch(base + p, init);

let res = await get("/games");
let list = await res.json();
if (!res.ok || res.headers.get("access-control-allow-origin") !== "*") fail(`GET /games ${res.status}`);
if (!list.some((m) => m.id === "sample")) fail(`sample not listed: ${JSON.stringify(list)}`); ok("GET /games lists the sample");

res = await get("/games/sample/meta.json");
const sampleMeta = await res.json();
if (sampleMeta.title !== "Pick A or B" || !sampleMeta.phases?.length) fail("sample meta"); ok("GET /games/sample/meta.json");

res = await get("/games/sample/tv.html");
let html = await res.text();
if (!res.headers.get("content-type")?.startsWith("text/html") || res.headers.get("cache-control") !== "no-store") fail(`tv.html headers ${[...res.headers]}`);
if (!html.includes("postMessage") || !html.includes('"init"')) fail("sample tv.html lacks the bridge"); ok("GET /games/sample/tv.html is HTML with postMessage, no-store");

if ((await get("/games/nope1234/tv.html")).status !== 404) fail("unknown id should 404"); ok("unknown game → 404");

res = await get("/author", { method: "OPTIONS", headers: { origin: "https://tv.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
if (res.status !== 204 || res.headers.get("access-control-allow-origin") !== "*" || !/POST/.test(res.headers.get("access-control-allow-methods") ?? "") || !/content-type/i.test(res.headers.get("access-control-allow-headers") ?? ""))
  fail(`preflight ${res.status} ${[...res.headers]}`);
ok("CORS preflight on /author → 204 with allow headers");

if ((await get("/author", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status !== 400) fail("empty prompt should 400"); ok("POST /author without prompt → 400");

const prompt = "A two-phase quiz where everyone guesses the year a photo was taken";
res = await get("/author?wait=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, context: { players: 3 } }) });
const authored = await res.json();
if (res.status !== 200 || !/^[a-z0-9]{8}$/.test(authored.id) || authored.meta?.id !== authored.id || authored.meta.prompt !== prompt || !authored.meta.createdAt)
  fail(`POST /author ${res.status} ${JSON.stringify(authored)}`);
ok(`POST /author?wait=1 → id ${authored.id} and meta`);

res = await get(`/games/${authored.id}/lobby.html`);
if (authored.meta.lobby !== true || res.status !== 200 || !(await res.text()).includes("lobby_ready")) fail(`authored lobby ${authored.meta.lobby} ${res.status}`);
ok("AUTHOR_FAKE stores the sample's lobby card too: meta.lobby true, GET /games/:id/lobby.html serves it");

res = await get(`/games/${authored.id}/tv.html`);
html = await res.text();
if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("text/html") || !html.includes("postMessage")) fail(`authored tv.html ${res.status}`);
ok("GET /games/:id/tv.html serves the authored bundle");

const meta = await get(`/games/${authored.id}/meta.json`).then((r) => r.json());
if (meta.id !== authored.id || meta.title !== authored.meta.title) fail("authored meta.json"); ok("GET /games/:id/meta.json matches");

res = await get("/author?wait=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "second game" }) });
const second = await res.json();
list = await get("/games").then((r) => r.json());
if (list[0]?.id !== second.id || list[1]?.id !== authored.id || list.at(-1).id !== "sample") fail(`order ${list.map((m) => m.id)}`);
ok("GET /games lists newest first, sample last");

// Async: 202 + jobId, then poll until done.
const asyncPrompt = "A drawing game where the TV guesses";
const t0 = Date.now();
res = await get("/author", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: asyncPrompt }) });
const queued = await res.json();
if (res.status !== 202 || queued.status !== "queued" || !/^[a-z0-9]{12}$/.test(queued.jobId) || res.headers.get("access-control-allow-origin") !== "*")
  fail(`async POST /author ${res.status} ${JSON.stringify(queued)}`);
ok(`POST /author → 202 queued, job ${queued.jobId} (${Date.now() - t0} ms)`);

const seen = [];
let job;
for (const until = Date.now() + 10_000; ;) {
  res = await get(`/author/${queued.jobId}`);
  if (res.status !== 200 || res.headers.get("access-control-allow-origin") !== "*") fail(`GET /author/:jobId ${res.status}`);
  job = await res.json();
  if (seen.at(-1) !== job.status) seen.push(job.status);
  if (job.status === "done" || job.status === "error") break;
  if (Date.now() > until) fail(`job still ${job.status} after 10 s`);
  await new Promise((r) => setTimeout(r, 100));
}
if (job.status !== "done" || job.jobId !== queued.jobId || job.prompt !== asyncPrompt || job.attempt !== 1 || !job.createdAt || !job.updatedAt
  || !/^[a-z0-9]{8}$/.test(job.id) || job.meta?.id !== job.id || job.meta.prompt !== asyncPrompt)
  fail(`job ${JSON.stringify(job)}`);
ok(`GET /author/:jobId reaches done with id ${job.id} and meta (states seen: ${seen.join(" → ")}, ${Date.now() - t0} ms)`);

res = await get(`/games/${job.id}/tv.html`);
if (res.status !== 200 || !(await res.text()).includes("postMessage")) fail(`async tv.html ${res.status}`);
ok("GET /games/:id/tv.html serves the async-authored bundle");

if ((await get("/author/zzzzzzzzzzzz")).status !== 404) fail("unknown job should 404");
if ((await get("/author/not-a-job")).status !== 404) fail("malformed job id should 404");
ok("unknown jobId → 404");

if (!process.env.RELAY_HTTP) { // this server has no PUBLISH_TOKEN
  res = await get("/author/claim", { method: "POST", headers: { "x-publish-token": "x", "content-type": "application/json" }, body: "{}" });
  if (res.status !== 503) fail(`claim without PUBLISH_TOKEN set should 503, got ${res.status}`);
  ok("runner routes → 503 when PUBLISH_TOKEN is unset");
}


// ---- runner mode ----
child?.kill(); child = null;
base = process.env.RELAY_RUNNER_HTTP;
const RECLAIM_MS = 2500;
if (!base) ({ base, child } = await start(["AUTHOR_MODE:runner", "PUBLISH_TOKEN:testtoken", "AUTHOR_FAKE:1", `AUTHOR_RECLAIM_MS:${RECLAIM_MS}`]));
const TOKEN = { "x-publish-token": process.env.RELAY_RUNNER_TOKEN ?? "testtoken", "content-type": "application/json" };
const post = (p, body, headers = TOKEN) => get(p, { method: "POST", headers, body: JSON.stringify(body) });
const author = async (prompt) => {
  const r = await post("/author", { prompt, context: { players: 2 } }, { "content-type": "application/json" });
  const b = await r.json();
  if (r.status !== 202 || b.status !== "queued" || !/^[a-z0-9]{12}$/.test(b.jobId)) fail(`runner POST /author ${r.status} ${JSON.stringify(b)}`);
  return b.jobId;
};
const jobState = (id) => get(`/author/${id}`).then((r) => r.json());

const jobA = await author("A runner-written trivia game");
await new Promise((r) => setTimeout(r, 400)); // AUTHOR_FAKE must not complete it on its own
let st = await jobState(jobA);
if (st.status !== "queued" || st.mode !== "runner" || st.attempt !== 0 || !st.createdAt || st.context?.players !== 2) fail(`queued job ${JSON.stringify(st)}`);
ok("runner mode: POST /author → 202 queued and it stays queued (no alarm, even with AUTHOR_FAKE)");

res = await get("/author?wait=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
if (res.status !== 400 || !/direct/.test((await res.json()).error)) fail(`?wait=1 in runner mode ${res.status}`);
ok("runner mode: POST /author?wait=1 → 400");

if ((await post("/author/claim", { runner: "mac" }, { "content-type": "application/json" })).status !== 403) fail("claim without token");
if ((await post("/author/claim", { runner: "mac" }, { ...TOKEN, "x-publish-token": "wrong" })).status !== 403) fail("claim with bad token");
ok("POST /author/claim without or with a wrong token → 403");

res = await get("/author/queue", { headers: TOKEN });
let q = await res.json();
if (res.status !== 200 || q.counts.queued !== 1 || q.queued[0]?.jobId !== jobA) fail(`queue ${res.status} ${JSON.stringify(q)}`);
if ((await get("/author/queue")).status !== 403) fail("queue without token");
ok("GET /author/queue → counts and queued ids (403 without token)");

res = await post("/author/claim", { runner: "mac" });
st = await res.json();
if (res.status !== 200 || st.jobId !== jobA || st.status !== "running" || st.runner !== "mac" || st.attempt !== 1 || !st.claimedAt || st.prompt !== "A runner-written trivia game")
  fail(`claim ${res.status} ${JSON.stringify(st)}`);
ok("POST /author/claim → 200 with the job, now running, attempt 1");

res = await post("/author/claim", { runner: "mac" });
if (res.status !== 204) fail(`second claim ${res.status}`); ok("second claim → 204 (nothing queued)");

for (const note of ["sandbox up", "pi is writing tv.html"]) {
  res = await post(`/author/${jobA}/progress`, { note, runner: "mac" });
  if (res.status !== 200) fail(`progress ${res.status} ${await res.text()}`);
}
st = await jobState(jobA);
if (st.log?.length !== 2 || !st.log[1].endsWith("pi is writing tv.html")) fail(`log ${JSON.stringify(st.log)}`);
ok("POST /author/:jobId/progress appends to the public log");

const sample = { meta: await get("/games/sample/meta.json").then((r) => r.json()), html: await get("/games/sample/tv.html").then((r) => r.text()),
  lobby: await get("/games/sample/lobby.html").then((r) => r.text()) };
const gid = "runner-" + Math.random().toString(36).slice(2, 8);
res = await post(`/author/${jobA}/complete`, { id: gid, meta: { ...sample.meta, id: gid } });
if (res.status !== 409) fail(`complete without a published bundle should 409, got ${res.status}`);
ok("complete { id, meta } before the bundle is published → 409");
res = await post(`/author/${jobA}/complete`, { id: gid, meta: { ...sample.meta, id: gid }, html: sample.html, lobby: '<!doctype html><script src="https://x.example/a.js"></script>' });
if (res.status !== 400 || !/script src/.test((await res.json()).error)) fail(`complete with an external-script lobby should 400, got ${res.status}`);
res = await post(`/author/${jobA}/complete`, { id: gid, meta: { ...sample.meta, id: gid }, lobby: sample.lobby });
if (res.status !== 400 || !/lobby needs html inline/.test((await res.json()).error)) fail(`complete with lobby but no html should 400, got ${res.status}`);
res = await post(`/author/${jobA}/complete`, { id: gid, meta: { ...sample.meta, id: gid, maxPlayers: 17 }, html: sample.html });
if (res.status !== 400 || !/maxPlayers/.test((await res.json()).error)) fail(`complete with maxPlayers 17 should 400, got ${res.status}`);
ok("complete rejects a lobby that loads a script, a lobby without inline html, and maxPlayers 17 → 400 (the job stays running)");
res = await post(`/author/${jobA}/complete`, { id: gid, meta: { ...sample.meta, id: gid, engine: "H13" }, html: sample.html, lobby: sample.lobby });
{ const b = await res.json();
  if (res.status !== 400 || !/gate S6: meta\.engine "H13" must be one of H1\.\.H12/.test(b.error)) fail(`complete with engine H13 should 400 from the gate, got ${res.status} ${JSON.stringify(b).slice(0, 300)}`); }
ok("complete with a bundle the static gate fails (meta.engine H13) → 400 listing gate S6");
res = await post(`/author/${jobA}/complete`, { id: gid, meta: { ...sample.meta, id: gid, title: "Runner game", lobby: false }, html: sample.html, lobby: sample.lobby, runner: "mac" });
if (res.status !== 200) fail(`complete inline ${res.status} ${await res.text()}`);
st = await jobState(jobA);
if (st.status !== "done" || st.id !== gid || st.meta?.id !== gid || st.meta.title !== "Runner game" || st.meta.lobby !== true || st.log?.length !== 2) fail(`done job ${JSON.stringify(st)}`);
res = await get(`/games/${gid}/lobby.html`);
if (res.status !== 200 || (await res.text()) !== sample.lobby) fail(`runner lobby.html ${res.status}`);
if ((await get("/games").then((r) => r.json())).find((m) => m.id === gid)?.lobby !== true) fail("runner game not listed with lobby:true");
ok("complete { id, meta, html, lobby } stores lobby.html: job meta.lobby true, listed lobby:true, GET /games/:id/lobby.html serves it");
res = await get(`/games/${gid}/tv.html`);
if (res.status !== 200 || !(await res.text()).includes("postMessage")) fail(`runner tv.html ${res.status}`);
if ((await get("/games").then((r) => r.json()))[0]?.id !== gid) fail("runner game not listed first");
ok("complete { id, meta, html } → job done with id/meta/log, GET /games/:id serves it");

if ((await post(`/author/${jobA}/complete`, { error: "late" })).status !== 409) fail("complete on a done job should 409");
ok("complete on a job that is not running → 409");

// Pre-published path: PUT /games/:id, then complete with { id, meta }.
const jobB = await author("Published first");
st = await post("/author/claim", { runner: "mac" }).then((r) => r.json());
if (st.jobId !== jobB) fail("claim B");
const gid2 = gid + "b";
res = await get(`/games/${gid2}`, { method: "PUT", headers: TOKEN, body: JSON.stringify({ meta: { ...sample.meta, id: gid2 }, html: sample.html }) });
if (res.status !== 200) fail(`PUT /games ${res.status}`);
res = await post(`/author/${jobB}/complete`, { id: gid2, meta: { ...sample.meta, id: gid2 } });
st = await jobState(jobB);
if (res.status !== 200 || st.status !== "done" || st.id !== gid2) fail(`complete after PUT ${res.status} ${JSON.stringify(st)}`);
ok("PUT /games/:id then complete { id, meta } → done");

const jobC = await author("Will fail");
await post("/author/claim", { runner: "mac" });
res = await post(`/author/${jobC}/complete`, { error: "pi gave up" });
st = await jobState(jobC);
if (res.status !== 200 || st.status !== "error" || st.error !== "pi gave up") fail(`error complete ${JSON.stringify(st)}`);
ok("complete { error } → job error");

// Reclaim: this server reclaims after AUTHOR_RECLAIM_MS (2.5 s here; 8 min by default).
const jobD = await author("Runner dies");
st = await post("/author/claim", { runner: "mac-1" }).then((r) => r.json());
if (st.jobId !== jobD) fail("claim D");
if ((await post("/author/claim", { runner: "mac-2" })).status !== 204) fail("fresh running job must not be reclaimed");
await new Promise((r) => setTimeout(r, RECLAIM_MS + 500));
res = await post("/author/claim", { runner: "mac-2" });
st = await res.json();
if (res.status !== 200 || st.jobId !== jobD || st.runner !== "mac-2" || st.attempt !== 2 || !/reclaimed from mac-1/.test(st.log?.at(-1) ?? "")) fail(`reclaim ${res.status} ${JSON.stringify(st)}`);
if ((await post(`/author/${jobD}/complete`, { error: "x", runner: "mac-1" })).status !== 409) fail("old runner completing should 409");
if ((await post(`/author/${jobD}/progress`, { note: "x", runner: "mac-1" })).status !== 409) fail("old runner progress should 409");
ok("a job running past the claim timeout is reclaimed (attempt 2); the old runner then gets 409");

q = await get("/author/queue", { headers: TOKEN }).then((r) => r.json());
if (q.counts.done !== 2 || q.counts.error !== 1 || q.counts.running !== 1 || q.counts.queued !== 0) fail(`final counts ${JSON.stringify(q.counts)}`);
ok(`GET /author/queue counts ${JSON.stringify(q.counts)}`);

console.log(`\n${n} checks passed`); done(0);
