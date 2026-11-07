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
const wsBase = inBrowser ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host : "";

let ws = null, code = null, player = null, retry = 0, closedByTv = false;
const sensors = { gyro: null, camera: null, mic: null }; // active stop() functions

// ---------- join ----------
function renderJoin(msg) {
  stopPad(); stopClock();
  main.className = "join"; // drop any dead/expired state left by the previous screen
  // The remembered name is scoped to one room code, so a phone that joined an earlier room (or a
  // friend's room) starts clean here and never auto-joins as someone else.
  const prefillCode = (qs.get("c") ?? "").toUpperCase();
  const savedName = prefillCode ? (safeGet(localStorage, "lr.name." + prefillCode) ?? "") : "";
  main.innerHTML = `
    <h1>Join the TV</h1>
    <p>${msg ?? "Type the code on the screen."}</p>
    <input id="code" class="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE" value="${(qs.get("c") ?? "").toUpperCase()}" />
    <input id="name" maxlength="24" autocomplete="off" placeholder="Your name" value="${savedName}" />
    <button id="go">Join</button>`;
  const go = () => {
    const c = $("code").value.trim().toUpperCase(), n = $("name").value.trim();
    if (c.length !== 4) return toast("Four letters.");
    if (!n) return toast("A name helps the room.");
    safeSet(localStorage, "lr.name." + c, n);
    connect(c, n);
  };
  $("go").onclick = go;
  $("name").onkeydown = (e) => e.key === "Enter" && go();
  ($("code").value ? $("name") : $("code")).focus();
}

function connect(c, name) {
  code = c; closedByTv = false;
  const prev = safeGet(sessionStorage, "lr.player." + code);
  const url = `${wsBase}/join?code=${code}&name=${encodeURIComponent(name)}${prev ? "&player=" + prev : ""}`;
  ws = new WebSocket(url);
  ws.onopen = () => { retry = 0; };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    setTv("offline"); stopAllSensors();
    if (closedByTv || !player) return;
    const wait = Math.min(8000, 500 * 2 ** retry++);
    setTimeout(() => connect(code, name), wait);
  };
}

function send(frame) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame)); }
const input = (data) => send({ type: "input", data });
const sensor = (kind, data) => send({ type: "sensor", kind, data });

// ---------- frames from the relay / TV ----------
function handle(f) {
  switch (f.type) {
    case "joined":
      player = f.player; safeSet(sessionStorage, "lr.player." + f.code, player.id);
      $("hdr-code").innerHTML = `<b>${f.code}</b>`; $("hdr-name").textContent = player.name;
      renderScreen({ kind: "info", title: "You're in.", body: "Look at the TV." });
      break;
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
  stopPad();
  main.className = ""; stopClock();
  switch (s.kind) {
    case "info": main.innerHTML = `<h1>${esc(s.title)}</h1>${s.body ? `<p>${esc(s.body)}</p>` : ""}`; break;
    case "buttons":
      main.innerHTML = `${s.prompt ? `<h1>${esc(s.prompt)}</h1>` : ""}${s.items.map((b) => `<button data-id="${esc(b.id)}">${esc(b.label)}</button>`).join("")}`;
      main.querySelectorAll("button").forEach((b) => (b.onclick = () => { input({ kind: "button", id: b.dataset.id }); b.disabled = true; }));
      break;
    case "text": {
      const max = textMax(s);
      main.innerHTML = `<h1>${esc(s.prompt)}</h1><textarea id="t" rows="3" maxlength="${max}" placeholder="${esc(s.placeholder ?? "")}"></textarea><p class="count" id="count">0/${max}</p><button id="send">Send</button>`;
      const t = $("t"), count = $("count");
      t.oninput = () => { count.textContent = `${t.value.length}/${max}`; count.classList.toggle("full", t.value.length >= max); };
      $("send").onclick = () => { const v = t.value.trim().slice(0, max); if (!v) return; input({ kind: "text", text: v }); renderScreen({ kind: "info", title: "Sent.", body: "Look at the TV." }); };
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
  if (frame) input(frame);
  stopPad();
  main.querySelectorAll("button[data-id], #t, #send").forEach((e) => (e.disabled = true));
  main.querySelectorAll(".pad, iframe").forEach((e) => e.classList.add("dead"));
  const msg = document.createElement("h1"); msg.className = "timesup"; msg.textContent = "Time's up, look at the TV.";
  main.querySelector(".countdown")?.after(msg);
}
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
  pad.onpointerup = pad.onpointercancel = () => { active = false; x = y = 0; dot.style.left = "50%"; dot.style.top = "50%"; input({ kind: "pad", x: 0, y: 0 }); };
  padTimer = setInterval(() => active && input({ kind: "pad", x: +x.toFixed(3), y: +y.toFixed(3) }), 50);
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
