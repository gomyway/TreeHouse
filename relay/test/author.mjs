// Game storage + authoring manager against `wrangler dev --var AUTHOR_FAKE:1` (no API key needed):
// the sample bundle is served from an empty bucket, POST /author?wait=1 stores a new bundle that the
// TV can then pull, the listing puts it first, CORS preflight works, and async POST /author returns a
// job that polling GET /author/:jobId follows to done. Local R2 state goes to a fresh
// temp dir so runs don't see each other. Targets RELAY_HTTP (http://host:port) when set instead.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const wranglerBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/wrangler");

let base = process.env.RELAY_HTTP, child = null;
if (!base) {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-author-"));
  const logPath = path.join(tmp, "wrangler.log");
  const logFd = fs.openSync(logPath, "w"); // never leave a child pipe undrained: it blocks the child
  child = spawn(wranglerBin, ["dev", "--port", String(port), "--var", "AUTHOR_FAKE:1", "--persist-to", path.join(tmp, "state")],
    { stdio: ["ignore", logFd, logFd] });
  process.on("exit", (code) => {
    if (code) console.error(`wrangler log (${logPath}):\n` + fs.readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n"));
    else fs.rmSync(tmp, { recursive: true, force: true });
  });
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 90_000) { console.error("wrangler dev did not start in 90 s"); child.kill(); process.exit(1); }
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  base = `http://127.0.0.1:${port}`;
}
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

console.log(`\n${n} checks passed`); done(0);
