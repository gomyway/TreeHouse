// Unit checks for the runner's game-scope decision (runner/scope.mjs) and the Room memory
// "history" flag (runner/room-memory.mjs). No relay needed. Rule: PLAN.md "Game scope".
import { decideScope, applyScope, UNKNOWN_TV } from "../runner/scope.mjs";
import { roomMemoryMarkdown, hasHistory } from "../runner/room-memory.mjs";

let n = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (m) => console.log(`ok ${++n} - ${m}`);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

eq(decideScope(undefined), { scope: "global" }, "no context");
eq(decideScope({}), { scope: "global" }, "empty context");
eq(decideScope({ players: [{ id: "p1", name: "Ada" }] }), { scope: "global" }, "players without guids");
eq(decideScope({ players: [{ id: "p1", name: "Ada", guid: "short" }] }), { scope: "global" }, "invalid guid ignored");
ok("no tvId, no memory, no guids → global");

eq(decideScope({ tvId: "tv-test-1" }), { scope: "tv", tvId: "tv-test-1", crew: [] }, "tvId only");
ok("context.tvId alone → tv, that tvId, empty crew");

const g = decideScope({ players: [{ guid: "guid-b-0002" }, { guid: "guid-a-0001" }, { guid: "guid-a-0001" }, { name: "x" }] });
eq([g.scope, g.tvId ?? null, g.crew], ["global", null, ["guid-a-0001", "guid-b-0002"]], "guids only");
if (!/no context\.tvId/.test(g.note ?? "")) fail(`note for missing tv: ${g.note}`);
ok("players with guids, no tvId → global (with a note), crew sorted and deduped");

const m = decideScope({}, true);
eq([m.scope, m.tvId ?? null, m.crew], ["global", null, []], "memory only");
if (!/memory-seeded: true/.test(m.note ?? "")) fail(`note should say memory-seeded: ${m.note}`);
ok("Room memory history injected without tvId → global, noted");

const both = decideScope({ tvId: "tv-9", players: [{ guid: "guid-c-0003" }] }, true);
eq(both, { scope: "tv", tvId: "tv-9", crew: ["guid-c-0003"] }, "all three");
const dirty = decideScope({ tvId: "tv 9/home" });
eq([dirty.scope, dirty.tvId], ["tv", "tv-9-home"], "invalid tvId sanitized");
if (!dirty.note) fail("sanitized tvId should carry a note");
eq(decideScope({ tvId: "" }).scope, "global", "empty tvId");
ok("tvId + guids + memory → tv with both; an invalid tvId is sanitized (noted); empty → global");

eq(applyScope({ id: "x", scope: "tv", tvId: "old", crew: ["a"] }, { scope: "global" }), { id: "x", scope: "global" }, "apply global");
eq(applyScope({ id: "x" }, both), { id: "x", scope: "tv", tvId: "tv-9", crew: ["guid-c-0003"] }, "apply tv");
ok("applyScope overwrites whatever the agent wrote into meta");

const players = [{ id: "p1", name: "Ada", guid: "guid-a-0001" }];
const first = roomMemoryMarkdown(players, null);
const hist = roomMemoryMarkdown(players, { players: { "guid-a-0001": { names: ["Ada"], games: 2, lastSeen: 1, awards: [], moments: [], results: [] } }, crews: [] });
if (hasHistory("") || hasHistory(first) || !hasHistory(hist)) fail(`hasHistory: "" ${hasHistory("")}, first ${hasHistory(first)}, history ${hasHistory(hist)}`);
ok('hasHistory: false for no block and the "first game together" block, true for real history');

console.log(`\n${n} checks passed`);
