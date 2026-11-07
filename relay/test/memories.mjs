// /memories against `wrangler dev --var AUTHOR_MODE:runner --var PUBLISH_TOKEN:testtoken` with local
// state in a fresh temp dir: a fake TV opens a room for its code + hostToken, POST /memories with a
// wrong token → 403, the right one → 200; GET /memories?guids= returns per-player history (games,
// awards, moments without clips) and the crew; the runner's "Room memory" block renders from it;
// DELETE /memories/:guid forgets a player and scrubs the game, crew and co-player files.
// Targets RELAY_HTTP (http://host:port) when set.
import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { roomMemorySection } from "../runner/room-memory.mjs";
const wranglerBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/wrangler");

let base = process.env.RELAY_HTTP, child = null, tmp = null, logPath = null;
if (!base) {
  const port = 20000 + Math.floor(Math.random() * 1000);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-memories-"));
  logPath = path.join(tmp, "wrangler.log");
  const logFd = fs.openSync(logPath, "w"); // never leave a child pipe undrained: it blocks the child
  child = spawn(wranglerBin, ["dev", "--port", String(port), "--var", "AUTHOR_MODE:runner", "--var", "PUBLISH_TOKEN:testtoken", "--persist-to", path.join(tmp, "state")],
    { stdio: ["ignore", logFd, logFd] });
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 90_000) { console.error("wrangler dev did not start in 90 s"); child.kill(); process.exit(1); }
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  base = `http://127.0.0.1:${port}`;
}
process.on("exit", (code) => {
  if (code && logPath) console.error(`wrangler log (${logPath}):\n` + fs.readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n"));
  else if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
let tv = null;
const done = (code) => { try { tv?.close(); } catch {} child?.kill(); process.exit(code); };
const fail = (m) => { console.error("FAIL:", m); done(1); };
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const open = (p) => new Promise((res, rej) => { const ws = new WebSocket(base.replace(/^http/, "ws") + p); ws.on("open", () => res(ws)); ws.on("error", rej); });
const next = (ws, type) => new Promise((res) => { const h = (raw) => { const f = JSON.parse(raw); if (!type || f.type === type) { ws.off("message", h); res(f); } }; ws.on("message", h); });
const api = (p, method = "GET", body) => fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });

tv = await open("/host");
const room = await next(tv, "room");
ok(`room ${room.code}`);

const G1 = "guid-ada-0001", G2 = "guid-bo-00002", G3 = "guid-nobody-3";
const at = Date.now();
const clip = [{ t: -400, people: [{ n: 1, pts: Array.from({ length: 34 }, (_, i) => (i % 7) / 10) }] }, { t: 0, people: [{ n: 1, pts: Array(34).fill(-1) }] }];
const moments = [
  { id: "m_aaa1", at: at - 2000, game: "Mirror Match", title: "Bo froze like a statue", caption: "Two full seconds", players: ["Bo", "Ada"], playerGuids: [G2, G1], kind: "funny", crew: [G2, G1], clip },
  { id: "m_aaa2", at: at - 1000, game: "Mirror Match", title: "Most Robotic Human", players: ["Ada", "Bo"], playerGuids: [G1, G2], kind: "award", crew: [G1, G2] },
];
const result = { at, game: "Mirror Match", winner: "Ada", scores: { Ada: 5, Bo: 3 }, crew: [G1, G2], winnerGuid: G1, scoresByGuid: { [G1]: 5, [G2]: 3 } };
const post = { tvId: "tv-test", room: room.code, game: "Mirror Match", at, moments, result };

let res = await api("/memories", "OPTIONS");
if (res.status !== 204 || res.headers.get("access-control-allow-origin") !== "*" || !/DELETE/.test(res.headers.get("access-control-allow-methods") ?? "")) fail(`preflight ${res.status}`);
ok("CORS preflight on /memories");

res = await api("/memories", "POST", { ...post, hostToken: "nope" });
if (res.status !== 403) fail(`wrong token → ${res.status}`); ok("POST /memories with a wrong hostToken → 403");
res = await api("/memories", "POST", { ...post, room: "ZZZZ", hostToken: room.hostToken });
if (res.status !== 403) fail(`token for another room → ${res.status}`); ok("POST /memories with the token of another room → 403");

res = await api("/memories", "POST", { ...post, hostToken: room.hostToken });
const posted = await res.json();
if (res.status !== 200 || posted.moments !== 2 || posted.clips !== 1 || posted.players !== 2 || posted.crew !== 2) fail(`post ${res.status} ${JSON.stringify(posted)}`);
ok(`POST /memories → 200 ${JSON.stringify(posted)}`);

res = await api(`/memories?guids=${G1},${G2},${G3}`);
let mem = await res.json();
const a = mem.players?.[G1];
if (!a || a.games !== 1 || a.names[0] !== "Ada" || a.awards.length !== 1 || a.awards[0].title !== "Most Robotic Human") fail(`g1 ${JSON.stringify(a)}`);
if (a.moments.length !== 2 || a.moments.some((m) => m.clip) || a.results[0]?.winnerGuid !== G1) fail(`g1 moments ${JSON.stringify(a.moments)}`);
ok("g1: 1 game, the award, 2 moments without clips, the result");
if (G3 in mem.players) fail("g3 should be absent"); ok("unknown guid absent from players");
const crew = mem.crews?.[0];
if (mem.crews.length !== 1 || crew.guids.join() !== [G1, G2].sort().join() || crew.games !== 1 || crew.moments.length !== 2 || crew.moments.some((m) => m.clip)) fail(`crews ${JSON.stringify(mem.crews)}`);
ok("crews: the g1+g2 crew with 2 moments");

// Re-posting the same game is idempotent (no double count).
await api("/memories", "POST", { ...post, hostToken: room.hostToken });
mem = await (await api(`/memories?guids=${G1}`)).json();
if (mem.players[G1].games !== 1 || mem.players[G1].moments.length !== 2) fail(`repost ${JSON.stringify(mem.players[G1])}`); ok("same game posted twice counts once");

const block = await roomMemorySection(base, { players: [{ id: "p1", name: "Ada", guid: G1 }, { id: "p2", name: "Bo", guid: G2 }, { id: "p3", name: "Cy", guid: G3 }] });
if (!/## Room memory/.test(block) || !/\*\*Ada\*\*: 1 game played/.test(block) || !/Most Robotic Human/.test(block) || !/Ada \+ Bo|Bo \+ Ada/.test(block) || !/Players expected at start[\s\S]*Ada, Bo, Cy/.test(block)) fail(`block:\n${block}`);
ok("runner Room memory block renders");
if (process.env.SHOW_BLOCK) console.log("\n" + block);
const empty = await roomMemorySection(base, { players: [{ id: "p3", name: "Cy", guid: G3 }] });
if (!/No history yet: this is their first game together\./.test(empty)) fail(`empty block:\n${empty}`); ok("no history → first-game line");
const down = await roomMemorySection("http://127.0.0.1:9", { players: [{ id: "p1", name: "Ada", guid: G1 }] });
if (!/No history yet/.test(down)) fail("relay down should be non-fatal"); ok("relay unreachable → non-fatal, first-game line");

if ((await api(`/memories/${G3}`)).status !== 404) fail("GET g3 should 404"); ok("GET /memories/g3 → 404");
const idx = await (await api(`/memories/${G1}`)).json();
if (idx.guid !== G1 || idx.gameKeys.length !== 1) fail(`index ${JSON.stringify(idx)}`); ok("GET /memories/:guid → index");

res = await api(`/memories/${G1}`, "DELETE");
const del = await res.json();
if (res.status !== 200 || del.deleted.games !== 1 || del.deleted.crews !== 1 || del.deleted.players !== 1) fail(`delete ${res.status} ${JSON.stringify(del)}`);
ok(`DELETE /memories/g1 → 200 ${JSON.stringify(del.deleted)}`);
if ((await api(`/memories/${G1}`)).status !== 404) fail("g1 index still there"); ok("g1 index gone");
mem = await (await api(`/memories?guids=${G1},${G2}`)).json();
if (G1 in mem.players || mem.crews.length) fail(`after delete ${JSON.stringify(mem)}`); ok("g1 absent and the g1+g2 crew gone");
const bo = mem.players[G2];
const flat = JSON.stringify(bo);
if (!bo || flat.includes(G1) || flat.includes('"Ada"') || bo.moments.length !== 2) fail(`g2 not scrubbed ${flat}`);
ok("g2's index scrubbed of g1 and Ada, moments kept");
if ((await api(`/memories/${G1}`, "DELETE")).status !== 404) fail("second delete should 404"); ok("second DELETE → 404");

console.log(`\n${n} checks passed`); done(0);
