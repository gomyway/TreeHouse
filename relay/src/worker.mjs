// Relay on Cloudflare Workers. One Durable Object per room (keyed by its 4-letter code) holds the
// TV socket and the phone sockets and routes frames between them. No game logic lives here.
// The same Worker also serves game storage (/games, ./games.mjs) and the authoring manager
// (/author, ./author.mjs; its jobs run in the AuthorJob Durable Object) and memories (/memories, ./memories.mjs). Protocol: ../../shared/protocol.ts; bundle contract: ../../PLAN.md
import { handleGames } from "./games.mjs";
import { handleAuthor } from "./author.mjs";
import { handleMemories } from "./memories.mjs";
export { AuthorJob } from "./author.mjs";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const MAX_FRAME_BYTES = 256 * 1024;
const TV_GRACE_MS = 60_000;
const PLAYER_GRACE_MS = 5 * 60_000;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const parse = (raw) => {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES) return null;
  try { const f = JSON.parse(raw); return f && typeof f.type === "string" ? f : null; } catch { return null; }
};
const newCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
};
const GUID_RE = /^[A-Za-z0-9-]{8,64}$/; // the phone's per-device key (protocol.ts Player.guid)
const pub = (p) => ({
  id: p.id, name: p.name, connected: p.connected,
  ...(p.guid ? { guid: p.guid } : {}), ...(p.sameDevice ? { sameDevice: true } : {}),
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/author" || url.pathname.startsWith("/author/")) return handleAuthor(req, env, url);
    if (url.pathname === "/games" || url.pathname.startsWith("/games/")) return handleGames(req, env, url);
    if (url.pathname === "/memories" || url.pathname.startsWith("/memories/")) return handleMemories(req, env, url);
    if (url.pathname.startsWith("/rooms/")) { // debug: GET /rooms/ABCD
      const code = url.pathname.slice(7).toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "bad code" }, 400);
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(`https://room/status`));
    }
    if (url.pathname !== "/host" && url.pathname !== "/join") return env.ASSETS.fetch(req);
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });

    let code = (url.searchParams.get("code") ?? "").toUpperCase();
    if (url.pathname === "/join" || code) {
      if (!CODE_RE.test(code)) return new Response("bad code", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req);
    }
    // A TV asking for a fresh room: pick a code the DO reports free (409 = busy), a few tries.
    for (let i = 0; i < 6; i++) {
      code = newCode();
      const u = new URL(req.url); u.searchParams.set("code", code);
      const res = await env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(u, req));
      if (res.status !== 409) return res;
    }
    return new Response("no free room", { status: 503 });
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.code = null; this.hostToken = null; this.players = null; // Map id -> {id,name,connected,leftAt,guid?,sameDevice?}
    // Keep-alive: clients send the literal "ping" every ~20 s (carrier NAT drops silent sockets);
    // the runtime answers "pong" without waking this object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async load() {
    if (this.players) return;
    const s = await this.ctx.storage.get(["code", "hostToken", "players"]);
    this.code = s.get("code") ?? null; this.hostToken = s.get("hostToken") ?? null;
    this.players = new Map(Object.entries(s.get("players") ?? {}));
    const cutoff = Date.now() - PLAYER_GRACE_MS;
    for (const [id, p] of this.players) if (!p.connected && p.leftAt && p.leftAt < cutoff) this.players.delete(id);
  }
  save() { return this.ctx.storage.put({ code: this.code, hostToken: this.hostToken, players: Object.fromEntries(this.players) }); }

  // getWebSockets() still returns a socket while it is closing, including the one whose
  // webSocketClose is running, so "is there a live one" checks keep OPEN sockets only and can
  // exclude the socket being closed. Sends are still guarded: a socket can close mid-loop.
  static live(list, except = null) { return list.filter((w) => w !== except && w.readyState === WebSocket.OPEN); }
  tvSocket(except) { return Room.live(this.ctx.getWebSockets("tv"), except)[0] ?? null; }
  phoneSockets(to, except) { return Room.live(this.ctx.getWebSockets(to === "*" ? "phone" : "p:" + to), except); }
  playerList() { return [...this.players.values()].map(pub); }
  static send(ws, data) { try { ws.send(data); return true; } catch { return false; } }
  toTv(frame) { const tv = this.tvSocket(); if (tv) Room.send(tv, JSON.stringify(frame)); }
  toPhones(to, frame) { const data = JSON.stringify(frame); for (const w of this.phoneSockets(to)) Room.send(w, data); }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    if (url.pathname === "/status") return json({ code: this.code, tv: Boolean(this.tvSocket()), players: this.playerList() });
    // Internal (only memories.mjs reaches it): does this token own the room? POST /memories auth.
    if (url.pathname === "/verify-token") return json({ hostOk: Boolean(this.hostToken) && url.searchParams.get("token") === this.hostToken });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    if (url.pathname === "/host" && this.tvSocket() && url.searchParams.get("token") !== this.hostToken)
      return new Response("room busy", { status: 409 }); // the worker tries another code
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (url.pathname === "/host") await this.acceptTv(server, url); else await this.acceptPhone(server, url);
    return new Response(null, { status: 101, webSocket: client });
  }

  async acceptTv(ws, url) {
    const code = url.searchParams.get("code").toUpperCase();
    const token = url.searchParams.get("token");
    const live = this.tvSocket();
    const reattach = Boolean(this.hostToken) && token === this.hostToken;
    if (!reattach) { this.code = code; this.hostToken = crypto.randomUUID().replaceAll("-", ""); this.players = new Map(); }
    if (live) { try { live.close(4000, "replaced"); } catch {} }
    await this.ctx.storage.deleteAlarm();
    this.ctx.acceptWebSocket(ws, ["tv"]);
    ws.serializeAttachment({ role: "tv" });
    ws.send(JSON.stringify({ type: "room", code: this.code, hostToken: this.hostToken, players: this.playerList() }));
    this.toPhones("*", { type: "tv", status: "connected" });
    await this.save();
  }

  async acceptPhone(ws, url) {
    if (!this.hostToken) { // no such room: still accept so the phone gets a readable error frame
      this.ctx.acceptWebSocket(ws, ["dead"]); ws.serializeAttachment({ role: "dead" });
      ws.send(JSON.stringify({ type: "error", message: "no such room" })); ws.close(4004, "no such room"); return;
    }
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 24) || "Player";
    const wantId = url.searchParams.get("player");
    let player = wantId ? this.players.get(wantId) : null;
    const rejoin = Boolean(player);
    const rawGuid = url.searchParams.get("guid");
    const guid = rawGuid && GUID_RE.test(rawGuid) ? rawGuid : null; // invalid: ignored
    if (!player) {
      player = { id: crypto.randomUUID().slice(0, 8), name, connected: false, leftAt: null, guid };
      // Same guid already on a connected player here (two tabs on one phone): still a new player, flagged.
      if (guid && [...this.players.values()].some((o) => o.connected && o.guid === guid)) player.sameDevice = true;
      this.players.set(player.id, player);
    } else if (!player.guid && guid) player.guid = guid; // a rejoin never replaces an existing guid
    for (const old of this.phoneSockets(player.id)) { try { old.close(4000, "replaced"); } catch {} }
    player.connected = true; player.leftAt = null;
    this.ctx.acceptWebSocket(ws, ["phone", "p:" + player.id]);
    ws.serializeAttachment({ role: "phone", id: player.id });
    ws.send(JSON.stringify({ type: "joined", code: this.code, player: pub(player) }));
    ws.send(JSON.stringify({ type: "tv", status: this.tvSocket() ? "connected" : "reconnecting" }));
    this.toTv({ type: rejoin ? "rejoin" : "join", player: pub(player) });
    await this.save();
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    const att = ws.deserializeAttachment();
    const f = parse(raw);
    if (!f || !att) return;
    if (att.role === "tv") {
      if (f.type === "kick" && typeof f.to === "string") {
        const p = this.players.get(f.to); if (!p) return;
        this.toPhones(p.id, f); for (const w of this.phoneSockets(p.id)) { try { w.close(4001, "kicked"); } catch {} }
        this.players.delete(p.id); await this.save(); return;
      }
      const to = f.to ?? "*";
      if (to !== "*" && !this.players.has(to)) return;
      this.toPhones(to, f);
    } else if (att.role === "phone") {
      if (f.type !== "input" && f.type !== "sensor") return;
      const tv = this.tvSocket();
      const delivered = Boolean(tv) && Room.send(tv, JSON.stringify({ ...f, player: att.id }));
      // Ack numbered inputs so the phone can show the tap landed (or that the TV is away and it should
      // tap again later). Sensor streams are never acked.
      if (f.type === "input" && typeof f.seq === "number") Room.send(ws, JSON.stringify({ type: "ack", seq: f.seq, delivered }));
    }
  }

  async webSocketClose(ws) {
    await this.load();
    const att = ws.deserializeAttachment();
    if (!att || att.role === "dead") return;
    if (att.role === "tv") {
      if (this.tvSocket(ws)) return; // replaced by a newer TV socket
      this.toPhones("*", { type: "tv", status: "reconnecting" });
      await this.ctx.storage.setAlarm(Date.now() + TV_GRACE_MS);
      return;
    }
    const p = this.players.get(att.id);
    if (!p || this.phoneSockets(att.id, ws).length) return; // replaced by a newer phone socket
    p.connected = false; p.leftAt = Date.now();
    this.toTv({ type: "leave", player: pub(p) });
    await this.save();
  }
  webSocketError(ws) { return this.webSocketClose(ws); }

  async alarm() { // TV never came back: close the room
    await this.load();
    if (this.tvSocket()) return;
    this.toPhones("*", { type: "tv", status: "closed" });
    for (const w of this.ctx.getWebSockets()) { try { w.close(1000, "room closed"); } catch {} }
    await this.ctx.storage.deleteAll();
    this.code = null; this.hostToken = null; this.players = new Map();
  }
}
