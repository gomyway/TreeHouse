// The static pre-save gate (src/gate.mjs): the sample and the hand-built bundles pass, each check trips
// on a mutation of the sample, and one bundle takes well under 300 ms. Plain node, no DOM, no wrangler.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { staticGate, sayWords } from "../src/gate.mjs";

const relayDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (id, f) => { const p = path.join(relayDir, "games", id, f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; };
const bundle = (id) => ({ html: read(id, "tv.html"), meta: JSON.parse(read(id, "meta.json")), lobby: read(id, "lobby.html") });
const S = bundle("sample");
let n = 0, bad = 0;
const ok = (m) => console.log(`ok ${++n} - ${m}`);
const no = (m) => { bad++; console.error(`FAIL ${m}`); };

for (const id of fs.readdirSync(path.join(relayDir, "games")).filter((d) => fs.existsSync(path.join(relayDir, "games", d, "meta.json")))) {
  const r = staticGate(bundle(id));
  if (!r.ok) no(`${id} fails the gate: ${r.fails.map((f) => `${f.code} ${f.msg}`).join("; ")}`);
  else if (r.ms >= 300) no(`${id} took ${r.ms} ms`);
  else ok(`${id} passes the gate in ${r.ms} ms (${r.warns.length} warns: ${[...new Set(r.warns.map((w) => w.code))].join(" ")})`);
}
if (staticGate(S).warns.some((w) => w.code === "L0")) no("sample warns L0 although it has a lobby"); else ok("sample has its lobby card (no L0)");

const sub = (src, a, b) => { if (!src.includes(a)) throw new Error(`sample no longer contains ${a}`); return src.split(a).join(b); };
const css = (x) => sub(S.html, "</style>", x + "\n</style>");
const lobCss = (x) => sub(S.lobby, "</style>", x + "\n</style>");
const { engine, ...noEngine } = S.meta;
// [name, mutated bundle, code, "fail" | "warn"]
const cases = [
  ["S1 unknown palette", { meta: { ...S.meta, palette: "Purple" } }, "S1", "fail"],
  ["S1 missing palette", { meta: (({ palette, ...m }) => m)(S.meta) }, "S1", "warn"],
  ["S2 short hook", { meta: { ...S.meta, hook: "A studio." } }, "S2", "fail"],
  ["S3 five seats", { meta: { ...S.meta, seats: S.meta.seats.slice(0, 5) } }, "S3", "fail"],
  ["S3 seat with <text>", { meta: { ...S.meta, seats: S.meta.seats.map((s, i) => i ? s : { ...s, svg: s.svg.replace("</svg>", "<text>M</text></svg>") }) } }, "S3", "fail"],
  ["S4 min > max", { meta: { ...S.meta, minPlayers: 5, maxPlayers: 4 } }, "S4", "fail"],
  ["S4 narrow range", { meta: { ...S.meta, minPlayers: 4, maxPlayers: 6 } }, "S4", "warn"],
  ["S5 unused phase", { meta: { ...S.meta, phases: [...S.meta.phases, "bonus"] } }, "S5", "warn"],
  ["S5 no phases", { meta: { ...S.meta, phases: [] } }, "S5", "fail"],
  ["S6 engine H13", { meta: { ...S.meta, engine: "H13" } }, "S6", "fail"],
  ["S6 engine missing", { meta: noEngine }, "S6", "warn"],
  ["S7 wrong accent token", { html: sub(S.html, "--accent: #ffb000", "--accent: #ff6a1f") }, "S7", "fail"],
  ["S8 small display", { html: S.html.replace(/--display: [\d.]+vh/, "--display: 8vh") }, "S8", "fail"],
  ["S8 raw font-size", { html: css(".x { font-size: 7vh; }") }, "S8", "warn"],
  ["S9 purple", { html: css(".x { color: #b98cff; }") }, "S9", "fail"],
  ["S9 rgb mint", { html: css(".x { color: rgb(64, 220, 130); }") }, "S9", "fail"],
  ["S9 seven stray colours", { html: css(".x { color: #ff0000; border-color: #00ff00; background: #0000ff; outline-color: #ff00ff; fill: #123456; stroke: #654321; caret-color: #00aa55; }") }, "S9", "warn"],
  ["S10 bold", { html: css(".x { font-weight: 700; }") }, "S10", "fail"],
  ["S10 font shorthand", { html: css(".x { font: bold 5vh sans-serif; }") }, "S10", "fail"],
  ["S10 <h1> without a weight rule", { html: S.html.replace(/font-weight\s*:\s*[1-5]00/g, "font-weight: normal") }, "S10", "warn"],
  ["S11 three emoji", { html: sub(S.html, "<script>", "<script>\n// ✨\u{1F3B2}\u{1F916}") }, "S11", "fail"],
  ["S12 pill", { html: css(".chip { border-radius: 99px; }") }, "S12", "warn"],
  ["S13 long say", { html: sub(S.html, '"Pick A or B. Side with the room to score."', '"Pick A or B tonight, everyone, and side with the room to score a lovely point."') }, "S13", "fail"],
  ["S13 stacked !", { html: sub(S.html, '"Pick A or B. Side with the room to score."', '"Pick A or B!! Side with the room."') }, "S13", "warn"],
  ["S14 no data-player", { html: S.html.replace(/data-player|dataset\.player/g, "dataset.who") }, "S14", "fail"],
  ["S14 no custom seat card", { html: S.html.replace(/kind: "custom"/g, 'kind: "info"') }, "S14", "warn"],
  ["S15 no done", { html: sub(S.html, 'type: "done"', 'type: "finished"') }, "S15", "fail"],
  ["S16 no award", { html: sub(S.html, 'kind: "award"', 'kind: "win"') }, "S16", "fail"],
  ["S17 fetch", { html: sub(S.html, "<script>", "<script>\nfetch('/x');") }, "S17", "fail"],
  ["S17 localStorage", { html: sub(S.html, "<script>", "<script>\nlocalStorage.x = 1;") }, "S17", "fail"],
  ["S18 text maxLength 100", { html: sub(S.html, "<script>", '<script>\nconst T = { kind: "text", prompt: "x", maxLength: 100 };') }, "S18", "warn"],
  ["S19 pad", { html: sub(S.html, "<script>", '<script>\nconst P = { kind: "pad" };') }, "S19", "warn"],
  ["S20 funniest copy", { html: sub(S.html, "<script>", '<script>\nconst V = "Vote for the funniest";') }, "S20", "warn"],
  ["L0 no lobby", { lobby: null }, "L0", "warn"],
  ["L1 lobby posts say", { lobby: sub(S.lobby, 'postMessage({ type: "lobby_ready" }', 'postMessage({ type: "say" }); window.parent.postMessage({ type: "lobby_ready" }') }, "L1", "fail"],
  ["L2 lobby audio", { lobby: sub(S.lobby, "</body>", '<audio src="data:audio/wav;base64,AA"></audio></body>') }, "L2", "fail"],
  ["L2 lobby external script", { lobby: sub(S.lobby, "</body>", '<script src="https://x.example/a.js"></script></body>') }, "L2", "fail"],
  ["L3 lobby still", { lobby: S.lobby.replace(/@keyframes/g, "@media print") }, "L3", "fail"],
  ["L4 lobby no data-status", { lobby: S.lobby.replace(/data-status/g, "data-line") }, "L4", "fail"],
  ["L4 lobby no slots", { lobby: S.lobby.replace(/data-slot|dataset\.slot/g, "dataset.gap") }, "L4", "fail"],
  ["L5 lobby no title hint", { lobby: S.lobby.replace(/<title>[^<]*<\/title>/g, "").replace(/aria-label/g, "data-x").replace(/font-size\s*:\s*(1[2-9]|[2-9]\d)(\.\d+)?vh/g, "font-size: 5vh") }, "L5", "warn"],
  ["S10 lobby bold", { lobby: lobCss(".x { font-weight: 800; }") }, "S10", "fail"],
];
for (const [name, mut, code, sev] of cases) {
  const r = staticGate({ ...S, ...mut });
  const list = sev === "fail" ? r.fails : r.warns;
  const hit = list.some((x) => x.code === code);
  if (!hit) no(`${name}: expected a ${sev} ${code}; fails ${JSON.stringify(r.fails.map((f) => f.code))} warns ${JSON.stringify(r.warns.map((w) => w.code))}`);
  else if (sev === "fail" && r.ok) no(`${name}: ok should be false`);
  else if (sev === "warn" && r.fails.length) no(`${name}: a warn-only mutation failed: ${r.fails.map((f) => f.code + " " + f.msg).join("; ")}`);
  else ok(`${name} → ${sev} ${code}`);
}

// Say-cap exemption: quoted spoken content and player-text placeholders do not count.
const w = (s, want) => (sayWords(s) === want ? ok(`sayWords ${JSON.stringify(s)} = ${want}`) : no(`sayWords ${JSON.stringify(s)} = ${sayWords(s)}, want ${want}`));
w('Riddle: "what has keys but cannot open a single lock at all" go.', 2);
w("${nameOf(a)} wrote \\\"${entry}\\\" and fooled ${and(fooled)}.", 3);
w("Round ${round + 1} of three.", 4);

// Timing: a 10x larger tv.html still well under 300 ms.
const big = staticGate({ ...S, html: S.html.repeat(10) });
if (big.ms >= 300) no(`10x sample took ${big.ms} ms`); else ok(`10x sample tv.html (${Math.round(S.html.length * 10 / 1024)} KB) in ${big.ms} ms`);

if (bad) { console.error(`${bad} gate check(s) failed`); process.exit(1); }
console.log(`\n${n} gate checks passed`);
