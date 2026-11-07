// Headless end-to-end against the relay: a fake TV opens a room, a fake phone joins, frames route both
// ways, rejoin works, kick works, a TV drop keeps the room and a token reattach restores it.
// Inputs carrying `seq` are acked to the phone (delivered:false while the TV is away).
// Targets RELAY_URL (ws://host:port) when set, otherwise starts `wrangler dev` on a random port.
import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const wranglerBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/wrangler");

let base = process.env.RELAY_URL, child = null;
if (!base) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const logPath = path.join(os.tmpdir(), `relay-e2e-${port}.log`);
  const logFd = fs.openSync(logPath, "w"); // never leave a child pipe undrained: it blocks the child
  child = spawn(wranglerBin, ["dev", "--port", String(port)], { stdio: ["ignore", logFd, logFd] });
  process.on("exit", (code) => { if (code) console.error(`wrangler log (${logPath}):\n` + fs.readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n")); });
  const started = Date.now();
  for (;;) { // poll /health until the local worker answers (wrangler's first start can take a while)
    if (Date.now() - started > 90_000) { console.error("wrangler dev did not start in 90 s"); child.kill(); process.exit(1); }
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  base = `ws://127.0.0.1:${port}`;
}
const done = (code) => { child?.kill(); process.exit(code); };
const fail = (m) => { console.error("FAIL:", m); done(1); };
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const open = (path) => new Promise((res, rej) => { const ws = new WebSocket(base + path); ws.on("open", () => res(ws)); ws.on("error", rej); });
const next = (ws, type) => new Promise((res) => { const h = (raw) => { const f = JSON.parse(raw); if (!type || f.type === type) { ws.off("message", h); res(f); } }; ws.on("message", h); });
const send = (ws, f) => ws.send(JSON.stringify(f));

const tv = await open("/host");
const room = await next(tv, "room");
if (!/^[A-HJ-NP-Z]{4}$/.test(room.code) || !room.hostToken) fail(`bad room ${JSON.stringify(room)}`); ok(`room ${room.code}`);

// On Workers the Room DO notifies the TV before its 101 reaches the phone, so the TV-side frame can
// land before the phone's `open` fires: listen on the TV before opening the phone socket.
const joinP = next(tv, "join");
const phone = await open(`/join?code=${room.code.toLowerCase()}&name=Ana`);
const [joined, joinEv] = await Promise.all([next(phone, "joined"), joinP]);
if (joined.player.name !== "Ana" || joinEv.player.id !== joined.player.id) fail("join mismatch"); ok("phone joined, tv notified");

send(tv, { type: "screen", to: joined.player.id, screen: { kind: "buttons", items: [{ id: "a", label: "A" }] } });
if ((await next(phone, "screen")).screen.kind !== "buttons") fail("screen not routed"); ok("tv → phone screen");

send(phone, { type: "input", data: { id: "a" } });
const inp = await next(tv, "input"); if (inp.player !== joined.player.id || inp.data.id !== "a") fail("input not stamped"); ok("phone → tv input stamped with player");

const ackP = next(phone, "ack"), seqInP = next(tv, "input");
send(phone, { type: "input", seq: 7, data: { kind: "button", id: "a" } });
const [ack, seqIn] = await Promise.all([ackP, seqInP]);
if (ack.seq !== 7 || ack.delivered !== true) fail(`ack ${JSON.stringify(ack)}`);
if (seqIn.seq !== 7 || seqIn.player !== joined.player.id) fail(`tv input seq ${JSON.stringify(seqIn)}`); ok("input with seq → tv gets it, phone gets ack delivered:true");

send(tv, { type: "state", payload: { round: 1 } });
if ((await next(phone, "state")).payload.round !== 1) fail("broadcast state"); ok("tv → all state");

phone.close(); if ((await next(tv, "leave")).player.id !== joined.player.id) fail("leave"); ok("leave on disconnect");

const rejoinP = next(tv, "rejoin");
const phone2 = await open(`/join?code=${room.code}&player=${joined.player.id}`);
const [j2, rj] = await Promise.all([next(phone2, "joined"), rejoinP]);
if (j2.player.id !== joined.player.id || rj.player.name !== "Ana") fail("rejoin"); ok("rejoin keeps id and name");

const bad = await open("/join?code=ZZZZ");
if ((await next(bad, "error")).message !== "no such room") fail("no-room error"); ok("unknown code rejected with a readable error");

const join3P = next(tv, "join");
const phone3 = await open(`/join?code=${room.code}&name=Bo`); await next(phone3, "joined"); await join3P;
send(tv, { type: "kick", to: joined.player.id });
await next(phone2, "kick"); ok("kick delivered");

tv.close();
if ((await next(phone3, "tv")).status !== "reconnecting") fail("tv grace"); ok("tv drop → phones told reconnecting, room kept");

send(phone3, { type: "input", seq: 1, data: { kind: "button", id: "a" } });
const away = await next(phone3, "ack");
if (away.seq !== 1 || away.delivered !== false) fail(`ack while tv away ${JSON.stringify(away)}`); ok("input while tv away → ack delivered:false");

const backP = next(phone3, "tv"); // sent to phones while the new TV socket is still being accepted
const tv2 = await open(`/host?code=${room.code}&token=${room.hostToken}`);
const room2 = await next(tv2, "room");
if (room2.code !== room.code || !room2.players.some((p) => p.name === "Bo")) fail(`tv reattach ${JSON.stringify(room2)}`); ok("tv reattaches with host token and sees players");
if ((await backP).status !== "connected") fail("phones told tv is back"); ok("phones told tv is back");

const status = await fetch(base.replace(/^ws/, "http") + `/rooms/${room.code}`).then((r) => r.json());
if (!status.tv || status.players.length !== 1) fail(`status ${JSON.stringify(status)}`); ok("status endpoint");

console.log(`\n${n} checks passed`); done(0);
