// Phone shell: joins a room by code, renders the screens the TV sends, streams the sensors the TV asks for.
// No game logic here. Protocol: ../shared/protocol.ts
// The pure helpers (remaining, secondsLabel, expiryInput) are exported for relay/test/phone.mjs,
// which imports this file under Node; everything touching the DOM is skipped there.
const inBrowser = typeof document !== "undefined";
const $ = (id) => document.getElementById(id);
const main = inBrowser ? $("main") : null;
const qs = new URLSearchParams(inBrowser ? location.search : "");
const safeGet = (store, k) => { try { return store.getItem(k); } catch { return null; } };
const safeSet = (store, k, v) => { try { store.setItem(k, v); } catch {} };
// Per-device guid: generated once, kept in localStorage as `lr.guid`, sent on every /join so the TV can
// tie moments to the same person across rooms. Not an account and never derived from the name.
// Without storage (private mode, blocked) it lives for this page load only.
const newGuid = () => {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch {}
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
let sessionGuid = null;
function deviceGuid() {
  if (!inBrowser) return sessionGuid ??= newGuid();
  const saved = safeGet(localStorage, "lr.guid");
  if (saved) return saved;
  const g = sessionGuid ?? newGuid();
  sessionGuid = g; safeSet(localStorage, "lr.guid", g);
  return g;
}
// "Forget me on this TV": drop the guid and every remembered room name, start over as a new face.
// TODO: also call the Worker's DELETE /memories/:guid (with the old guid) once that route exists.
function forgetMe() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k === "lr.guid" || k?.startsWith("lr.name.")) keys.push(k); }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {}
  sessionGuid = null; deviceGuid();
}
const wsBase = inBrowser ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host : "";

let ws = null, code = null, player = null, retry = 0, closedByTv = false;
const sensors = { gyro: null, camera: null, mic: null }; // active stop() functions

// ---------- join ----------
function renderJoin(msg) {
  stopPad(); stopClock(); clearPending(); unacked.clear(); // left the room: nothing to resend
  main.className = "join"; // drop any dead/expired state left by the previous screen
  // The remembered name is scoped to one room code, so a phone that joined an earlier room (or a
  // friend's room) starts clean here and never auto-joins as someone else.
  const prefillCode = (qs.get("c") ?? "").toUpperCase();
  const savedName = prefillCode ? (safeGet(localStorage, "lr.name." + prefillCode) ?? "") : "";
  main.innerHTML = `
    <h1>Join the TV</h1>
    <p>${msg ?? "Type the code on the screen."}</p>
    <label class="field">Room code on the TV<input id="code" class="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ABCD" value="${esc(prefillCode)}" /></label>
    <label class="field">Your name<input id="name" maxlength="24" autocomplete="off" autocapitalize="words" placeholder="e.g. Ana" value="${esc(savedName)}" /></label>
    <button id="go">Join</button>
    <a id="forget" class="forget" href="#">Forget me on this TV</a>`;
    try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("lr.player.")) sessionStorage.removeItem(k); } catch {}
  $("forget").onclick = (e) => { e.preventDefault(); forgetMe(); $("name").value = ""; toast("Forgotten. You are a new face now."); };
  const go = () => {
    const c = $("code").value.trim().toUpperCase(), n = $("name").value.trim();
    if (c.length !== 4) return toast("Four letters.");
    if (!n) return toast("A name helps the room.");
    if (n.toUpperCase() === c) { $("name").value = ""; $("name").focus(); return toast("That's the room code. What's your name?"); }
    safeSet(localStorage, "lr.name." + c, n);
    connect(c, n);
  };
  $("go").onclick = go;
  // Must not return false: an on* handler that returns false cancels the event, which ate every
  // keystroke in the name box (paste still worked because it fires no keydown).
  $("name").onkeydown = (e) => { if (e.key === "Enter") go(); };
  // iOS Safari: a focus() without a user tap leaves the input "focused" with no keyboard, and tapping
  // an already-focused input does not bring the keyboard back, so the name box became untypable
  // whenever the QR prefilled the code. Only auto-focus where there is a real keyboard.
  const target = $("code").value ? $("name") : $("code");
  if (!matchMedia("(pointer: coarse)").matches) target.focus();
}

function connect(c, name) {
  if (c !== code) { unacked.clear(); clearPending(); } // never replay one room's answers into another
  code = c; closedByTv = false;
  const prev = safeGet(sessionStorage, "lr.player." + code);
  const url = `${wsBase}/join?code=${code}&name=${encodeURIComponent(name)}${prev ? "&player=" + prev : ""}&guid=${encodeURIComponent(deviceGuid())}`;
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  clearTimeout(reconnectTimer);
  lastName = name;
  const sock = new WebSocket(url);
  ws = sock;
  // A connect that hangs (dead radio, captive NAT) would otherwise sit in CONNECTING for a minute+.
  const connectTimer = setTimeout(() => { if (sock.readyState === 0) sock.close(); }, 10_000);
  // The relay attaches the player before the 101, so frames sent right after open are routed.
  sock.onopen = () => { clearTimeout(connectTimer); retry = 0; startHeartbeat(sock); flush(sock); };
  sock.onmessage = (e) => { if (ws === sock) heard(); if (e.data === "pong") return; handle(JSON.parse(e.data)); };
  sock.onclose = () => { clearTimeout(connectTimer); lost(sock, false); };
}
// The socket is gone (closed, or declared dead by the watchdog): go offline and reconnect.
function lost(sock, now) {
  if (ws !== sock) return; // superseded by a newer socket
  stopHeartbeat(); setTv("offline"); stopAllSensors();
  if (closedByTv) return;
  if (now) retry = 0;
  const wait = now ? 0 : Math.min(8000, 500 * 2 ** retry++);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(code, lastName), wait);
}

// Keep-alive + fast resume. Carrier NAT drops a silent WebSocket in 30-60 s and iOS kills sockets
// when the screen locks, so: heartbeat every 20 s, and reconnect at once when the page is visible again.
// A half-open socket (iOS after a screen dim, a NAT that forgot us) still reports OPEN while every
// frame vanishes, so readyState alone proves nothing: a ping that gets no pong (or any frame) within
// the watchdog window means the socket is dead, and we close it and reconnect at once.
let heartbeat = null, watchdog = null, reconnectTimer = null, lastName = null;
const PONG_WAIT_MS = 8000, RESUME_PONG_WAIT_MS = 4000;
function startHeartbeat(sock) {
  stopHeartbeat();
  heartbeat = setInterval(() => { if (sock.readyState === 1) { sock.send("ping"); expectPong(sock, PONG_WAIT_MS); } }, 20_000);
}
function stopHeartbeat() { clearInterval(heartbeat); heartbeat = null; clearTimeout(watchdog); watchdog = null; }
function heard() { clearTimeout(watchdog); watchdog = null; } // any frame proves the socket is alive
function expectPong(sock, ms) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    watchdog = null;
    if (ws !== sock) return;
    sock.onclose = sock.onmessage = null; try { sock.close(); } catch {}
    lost(sock, true);
  }, ms);
}
if (inBrowser) document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || closedByTv || !code || !lastName) return;
  if (ws && ws.readyState === 1) { try { ws.send("ping"); } catch {} expectPong(ws, RESUME_PONG_WAIT_MS); return; }
  if (!ws || ws.readyState > 1) { retry = 0; clearTimeout(reconnectTimer); connect(code, lastName); }
});

// ---------- outbound: inputs are queued and acked, streams are fire-and-forget ----------
// Every non-stream input carries an increasing `seq`; the relay answers { type: "ack", seq, delivered }.
// An input stays in `unacked` until its ack arrives, so one sent into a half-open socket (or tapped
// while offline) is sent again, in order, when the next socket opens. Capped at 20, dropped after 30 s.
// Sensor frames and the pad's 20 Hz stream are never queued: stale motion is worse than none.
const QUEUE_MAX = 20, QUEUE_TTL_MS = 30_000, ACK_WAIT_MS = 6000;
let seq = 0;
const unacked = new Map(); // seq -> { frame, at }
const isOpen = () => Boolean(ws && ws.readyState === 1);
function send(frame) {
  if (!isOpen()) return false;
  try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
}
function input(data, { stream = false } = {}) {
  if (stream) { send({ type: "input", data }); return null; }
  const frame = { type: "input", seq: ++seq, data };
  unacked.set(frame.seq, { frame, at: Date.now() });
  while (unacked.size > QUEUE_MAX) unacked.delete(unacked.keys().next().value); // oldest first
  send(frame);
  return frame.seq;
}
function flush(sock) {
  const cutoff = Date.now() - QUEUE_TTL_MS;
  for (const [s, e] of unacked) {
    if (e.at < cutoff) { unacked.delete(s); continue; }
    try { sock.send(JSON.stringify(e.frame)); } catch { return; }
  }
  if (pending) armAckTimer(); // the ack clock starts when the answer actually leaves the phone
}
const sensor = (kind, data) => send({ type: "sensor", kind, data });

// The answer the current screen is waiting on: { seq, ok(), retry(), timer }.
let pending = null;
function clearPending() { if (pending) clearTimeout(pending.timer); pending = null; }
function awaitAck(s, wasOpen, handlers) {
  clearPending();
  pending = { seq: s, ...handlers, timer: null };
  if (!wasOpen) toast("Reconnecting, your answer is queued");
  armAckTimer();
}
function armAckTimer() {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    if (!pending) return;
    if (!isOpen()) return armAckTimer(); // still queued: flush() re-arms once it is sent
    const p = pending; pending = null;
    toast("No answer from the TV yet");
    p.retry();
  }, ACK_WAIT_MS);
}
function onAck(f) {
  unacked.delete(f.seq);
  if (!pending || pending.seq !== f.seq) return;
  const p = pending; clearPending();
  if (f.delivered === false) { toast("TV is away. Tap again when it's back."); p.retry(); }
  else p.ok();
}

// ---------- frames from the relay / TV ----------
function handle(f) {
  switch (f.type) {
    case "joined": {
      // A reconnect as the same player keeps whatever is on screen (and any answer awaiting its ack);
      // the TV re-sends the screen it wants on rejoin.
      const resumed = player?.id === f.player.id;
      player = f.player; safeSet(sessionStorage, "lr.player." + f.code, player.id);
      $("hdr-code").innerHTML = `<b>${f.code}</b>`; $("hdr-name").textContent = player.name;
      if (!resumed) renderScreen({ kind: "info", title: "You're in.", body: "Look at the TV." });
      break;
    }
    case "ack": onAck(f); break;
    case "tv": setTv(f.status); if (f.status === "closed") { closedByTv = true; player = null; renderJoin("That room closed."); } break;
    case "error": closedByTv = true; renderJoin(f.message === "no such room" ? "No room with that code." : f.message); break;
    case "screen": renderScreen(f.screen); break;
    case "state": window.dispatchEvent(new CustomEvent("lr:state", { detail: f.payload })); forwardToCustom(f); break;
    case "ask": f.on ? startSensor(f.kind, f.hz) : stopSensor(f.kind); break;
    case "play": play(f); break;
    case "kick": closedByTv = true; player = null; renderJoin("The TV removed you."); break;
  }
}

function setTv(status) { $("hdr-tv").textContent = status === "connected" ? "● live" : status; }

// ---------- screens ----------
function renderScreen(s) {
  stopPad(); clearPending();
  main.className = ""; stopClock();
  switch (s.kind) {
    case "info": main.innerHTML = `<h1>${esc(s.title)}</h1>${s.body ? `<p>${esc(s.body)}</p>` : ""}`; break;
    case "buttons":
      main.innerHTML = `${s.prompt ? `<h1>${esc(s.prompt)}</h1>` : ""}${s.items.map((b) => `<button data-id="${esc(b.id)}">${esc(b.label)}</button>`).join("")}`;
      const btns = [...main.querySelectorAll("button[data-id]")];
      btns.forEach((b) => (b.onclick = () => {
        if (b.disabled) return;
        // Immediate feedback: the tapped one is outlined, every option locks until the ack (or a timeout).
        btns.forEach((x) => (x.disabled = true)); b.classList.add("pressed");
        const wasOpen = isOpen();
        const label = b.textContent;
        awaitAck(input({ kind: "button", id: b.dataset.id }), wasOpen, {
          ok: () => { b.textContent = label + " \u2713"; },
          retry: () => { if (timesUp()) return; b.classList.remove("pressed"); btns.forEach((x) => (x.disabled = false)); },
        });
      }));
      break;
    case "text": {
      const max = textMax(s);
      main.innerHTML = `<h1>${esc(s.prompt)}</h1><textarea id="t" rows="3" maxlength="${max}" placeholder="${esc(s.placeholder ?? "")}"></textarea><p class="count" id="count">0/${max}</p><button id="send">Send</button>`;
      const t = $("t"), count = $("count");
      t.oninput = () => { count.textContent = `${t.value.length}/${max}`; count.classList.toggle("full", t.value.length >= max); };
      const btn = $("send");
      btn.onclick = () => {
        const v = t.value.trim().slice(0, max); if (!v || btn.disabled) return;
        btn.disabled = t.disabled = true; btn.classList.add("pressed"); btn.textContent = "Sending\u2026";
        const wasOpen = isOpen();
        awaitAck(input({ kind: "text", text: v }), wasOpen, {
          ok: () => renderScreen({ kind: "info", title: "Sent.", body: "Look at the TV." }),
          retry: () => { btn.classList.remove("pressed"); btn.textContent = "Send"; if (!timesUp()) btn.disabled = t.disabled = false; },
        });
      };
      t.focus();
      break;
    }
    case "pad": main.innerHTML = `<div class="pad" id="pad"><span>${esc(s.label ?? "drag")}</span><div class="dot" id="dot"></div></div>`; startPad(); break;
    case "custom": main.innerHTML = ""; const fr = document.createElement("iframe"); fr.sandbox = "allow-scripts"; fr.srcdoc = s.html; main.appendChild(fr); break;
    default: main.innerHTML = `<p>Unknown screen: ${esc(s.kind)}</p>`;
  }
  if (Number.isFinite(s.deadline)) startClock(s);
}

// ---------- deadlines (screen.deadline is epoch ms; the phone's clock is assumed within ~1 s of the TV's) ----------
export const remaining = (deadline, now) => Math.max(0, deadline - now); // ms left, never negative
export const secondsLabel = (ms) => String(Math.ceil(ms / 1000)); // 4001..5000 ms shows "5", 0 shows "0"
const textMax = (s) => (Number.isInteger(s.maxLength) && s.maxLength > 0 ? s.maxLength : 140);
// What a screen sends by itself when its deadline passes: text auto-submits, everything else sends nothing.
export function expiryInput(s, typed) {
  if (s?.kind !== "text") return null;
  const v = String(typed ?? "").trim().slice(0, textMax(s));
  return v ? { kind: "text", text: v } : { kind: "text", text: "", late: true };
}

let clock = null;
function stopClock() { clearInterval(clock); clock = null; }
function startClock(s) {
  const total = Math.max(1, s.deadline - Date.now());
  const el = document.createElement("div"); el.className = "countdown";
  el.innerHTML = `<b></b><div class="bar"><i></i></div>`;
  main.prepend(el);
  const num = el.querySelector("b"), bar = el.querySelector("i");
  const tick = () => {
    const ms = remaining(s.deadline, Date.now());
    num.textContent = secondsLabel(ms);
    bar.style.width = `${(100 * ms) / total}%`;
    el.classList.toggle("urgent", ms <= 5000);
    if (ms === 0) { stopClock(); expire(s); }
  };
  tick(); if (!el.classList.contains("over")) clock = setInterval(tick, 250); // already expired: no interval
}
function expire(s) {
  main.querySelector(".countdown")?.classList.add("over");
  const frame = expiryInput(s, $("t")?.value);
  if (frame && !pending) input(frame); // a Send already in flight is the answer; don't send it twice
  stopPad();
  main.querySelectorAll("button[data-id], #t, #send").forEach((e) => (e.disabled = true));
  main.querySelectorAll(".pad, iframe").forEach((e) => e.classList.add("dead"));
  const msg = document.createElement("h1"); msg.className = "timesup"; msg.textContent = "Time's up, look at the TV.";
  main.querySelector(".countdown")?.after(msg);
}
const timesUp = () => Boolean(main.querySelector(".timesup"));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// custom screens post {type:"input", data} to the parent; we forward state to them
if (inBrowser) window.addEventListener("message", (e) => { const d = e.data; if (d && d.type === "input") input(d.data); });
function forwardToCustom(f) { const fr = main.querySelector("iframe"); if (fr) fr.contentWindow.postMessage(f, "*"); }

// ---------- pad (touch joystick, ~20 Hz) ----------
let padTimer = null;
function startPad() {
  const pad = $("pad"), dot = $("dot"); let x = 0, y = 0, active = false;
  const move = (e) => { const r = pad.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; x = Math.max(-1, Math.min(1, ((t.clientX - r.left) / r.width) * 2 - 1)); y = Math.max(-1, Math.min(1, ((t.clientY - r.top) / r.height) * 2 - 1)); dot.style.left = `${(x + 1) * 50}%`; dot.style.top = `${(y + 1) * 50}%`; };
  pad.onpointerdown = (e) => { active = true; move(e); }; pad.onpointermove = (e) => active && move(e);
  pad.onpointerup = pad.onpointercancel = () => { active = false; x = y = 0; dot.style.left = "50%"; dot.style.top = "50%"; input({ kind: "pad", x: 0, y: 0 }, { stream: true }); };
  padTimer = setInterval(() => active && input({ kind: "pad", x: +x.toFixed(3), y: +y.toFixed(3) }, { stream: true }), 50);
}
function stopPad() { clearInterval(padTimer); padTimer = null; }

// ---------- sensors (each needs a tap on iOS; we show a button when permission is required) ----------
async function startSensor(kind, hz) {
  stopSensor(kind);
  if (kind === "gyro") sensors.gyro = await startGyro(hz ?? 30);
  if (kind === "camera") sensors.camera = await startCamera(hz ?? 0);
  if (kind === "mic") sensors.mic = await startMic(hz ?? 10);
}
function stopSensor(kind) { sensors[kind]?.(); sensors[kind] = null; }
function stopAllSensors() { for (const k of Object.keys(sensors)) stopSensor(k); }

function needsTap(label) { // iOS gates motion/media behind a user gesture; resolve when tapped
  return new Promise((res) => { const b = document.createElement("button"); b.className = "ghost"; b.textContent = label; b.onclick = () => { b.remove(); res(); }; main.prepend(b); });
}
async function startGyro(hz) {
  if (typeof DeviceOrientationEvent?.requestPermission === "function") {
    await needsTap("Enable motion"); if ((await DeviceOrientationEvent.requestPermission()) !== "granted") return null;
  }
  let last = 0, o = {}, m = {};
  const onO = (e) => { o = { alpha: e.alpha, beta: e.beta, gamma: e.gamma }; tick(); };
  const onM = (e) => { const a = e.accelerationIncludingGravity ?? {}; const r = e.rotationRate ?? {}; m = { ax: a.x, ay: a.y, az: a.z, rx: r.alpha, ry: r.beta, rz: r.gamma }; };
  const tick = () => { const now = performance.now(); if (now - last < 1000 / hz) return; last = now; sensor("gyro", { ...o, ...m, t: Date.now() }); };
  window.addEventListener("deviceorientation", onO); window.addEventListener("devicemotion", onM);
  return () => { window.removeEventListener("deviceorientation", onO); window.removeEventListener("devicemotion", onM); };
}
async function startCamera(hz) {
  await needsTap("Enable camera");
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640 } }); } catch { toast("Camera refused."); return null; }
  const v = document.createElement("video"); v.autoplay = v.muted = v.playsInline = true; v.srcObject = stream;
  const b = document.createElement("button"); b.textContent = "Send photo";
  main.prepend(b); main.prepend(v);
  const snap = () => { const c = document.createElement("canvas"); const w = 480, h = Math.round((v.videoHeight / v.videoWidth) * w) || 360; c.width = w; c.height = h; c.getContext("2d").drawImage(v, 0, 0, w, h); sensor("camera", { jpeg: c.toDataURL("image/jpeg", 0.6), t: Date.now() }); };
  b.onclick = snap;
  const timer = hz > 0 ? setInterval(snap, 1000 / hz) : null;
  return () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); v.remove(); b.remove(); };
}
async function startMic(hz) {
  await needsTap("Enable microphone");
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast("Microphone refused."); return null; }
  const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const timer = setInterval(() => { an.getByteTimeDomainData(buf); let sum = 0; for (const s of buf) { const d = (s - 128) / 128; sum += d * d; } sensor("mic", { level: +Math.sqrt(sum / buf.length).toFixed(4), t: Date.now() }); }, 1000 / hz);
  return () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); ctx.close(); };
}

// ---------- output ----------
function play(f) {
  if (f.url) { const a = new Audio(f.url); a.play().catch(() => toast("Tap to allow sound.")); }
  else if (f.text && "speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(f.text));
}

let toastTimer; function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 2500); }

if (inBrowser) {
  renderJoin();
  // Auto-join only on a true rejoin: this phone already joined this exact room under a name.
  const c0 = (qs.get("c") ?? "").toUpperCase(), n0 = c0 ? safeGet(localStorage, "lr.name." + c0) : null;
  if (c0 && n0) connect(c0, n0);
}
