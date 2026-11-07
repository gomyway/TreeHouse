// node shared/humanize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, styleStats, findTell, injectTypos, pickMostHuman, scoreHuman, botDelayMs, looksLikeTypo } from "./humanize.ts";
import type { StyleStats } from "./humanize.ts";

const HUMANS = [
  "my moms minivan", "a raccoon in a tuxedo", "idk lol", "honestly my ex", "the dentist",
  "i'm just tired", "well that's awkward", "Taylor Swift obviously", "new york pizza at 3am", "don’t ask",
  "my dogs' toys", "same", "a very confused goose 🪿", "free snacks!!", "my boss lol",
  "nap time", "'cause it's friday", "teh microwave", "wink ;)", "oh, my landlord",
];

const lowerRoom: StyleStats = { medianLen: 14, maxLen: 30, lowerRate: 1, periodRate: 0, emojiRate: 0, exclaimRate: 0, typoRate: 0, lazyRate: 0.2 };

test("mulberry32 is deterministic and in [0,1)", () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const xs = Array.from({ length: 50 }, a), ys = Array.from({ length: 50 }, b);
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, Array.from({ length: 50 }, c));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test("seeded pipeline is reproducible", () => {
  const stats = { ...styleStats(HUMANS), typoRate: 0.5 };
  const cands = ["my cat filing taxes", "a goat in a hat", "grandmas wifi password"];
  const run = (seed: number) => pickMostHuman(cands, stats, { existing: HUMANS, rng: mulberry32(seed) });
  assert.deepEqual(run(7), run(7));
  assert.equal(injectTypos("the quick brown fox jumps", 0.5, mulberry32(9)), injectTypos("the quick brown fox jumps", 0.5, mulberry32(9)));
  assert.equal(botDelayMs([4000, 9000, 12000], 45000, mulberry32(3)), botDelayMs([4000, 9000, 12000], 45000, mulberry32(3)));
});

test("findTell catches each kind", () => {
  const cases: [string, RegExp, StyleStats?][] = [
    ["my mom — obviously", /dash/], ["my mom – obviously", /dash/],
    ["pizza; always pizza", /semicolon/],
    ['the "fun" uncle', /quotes/], ["the “fun” uncle", /quotes/], ["the 'fun' uncle", /quotes/], ["the ‘fun’ uncle", /quotes/],
    ["Ah, the dentist", /opener/], ["Well, my landlord", /opener/], ["*sips tea* my ex", /opener/],
    ["Answer: my cat", /label/],
    ["a whimsical goose", /whimsical/], ["let's delve into it", /delve/], ["a tapestry of regret", /tapestry/],
    ["a testament to snacks", /testament/], ["it's worth noting my cat", /worth noting/], ["it’s worth noting my cat", /worth noting/],
    ["As an AI I can't say", /as an ai/], ["I'm just an AI lol", /just an ai/], ["nuanced feelings", /nuanced/],
    ["a vibrant multifaceted cat", /vibrant/],
    ["x".repeat(60), /too long/, lowerRoom],
    ["my Very Angry Landlord", /title case/, lowerRoom],
    ["The Angry Landlord", /title case/],
  ];
  for (const [s, re, stats] of cases) {
    const t = findTell(s, stats);
    assert.ok(t && re.test(t), `${s} → ${t}`);
  }
  assert.equal(findTell("x".repeat(60)), null, "too-long needs stats");
});

test("no false positives on 20 plain human answers", () => {
  const stats = styleStats(HUMANS);
  for (const h of HUMANS) {
    assert.equal(findTell(h), null, h);
    assert.equal(findTell(h, stats), null, h);
  }
});

test("styleStats on a known set", () => {
  const s = styleStats(["idk", "My cat.", "pizza!! 🍕", "teh dentist", "a very long answer here"]);
  assert.equal(s.medianLen, 9); // lengths 3,7,9,11,23 (🍕 is one char)
  assert.equal(s.maxLen, 23);
  assert.equal(s.lowerRate, 0.8);
  assert.equal(s.periodRate, 0.2);
  assert.equal(s.emojiRate, 0.2);
  assert.equal(s.exclaimRate, 0.2);
  assert.equal(s.lazyRate, 0.8); // idk, My cat., pizza!! 🍕, teh dentist
  assert.equal(s.typoRate, 1 / 12); // "teh" out of 12 words
  assert.ok(looksLikeTypo("teh") && looksLikeTypo("thhe") && !looksLikeTypo("the") && !looksLikeTypo("raccoon"));
  assert.equal(styleStats([]).medianLen > 0, true);
});

test("pickMostHuman: all tells → null", () => {
  const r = pickMostHuman(["Ah, the dentist", "a whimsical goose", "pizza; always", "my mom — truly"], lowerRoom, { existing: [], rng: mulberry32(1) });
  assert.equal(r, null);
  // (null carries no reasons; the host falls back to its own canned answer)
});

test("pickMostHuman rejects tells and duplicates, keeps the rest", () => {
  const r = pickMostHuman(["a whimsical goose", "My Moms Minivan", "the dentist", "free snacks"], lowerRoom,
    { existing: ["my moms minivan!", "the dentist"], rng: mulberry32(1) });
  assert.ok(r);
  assert.equal(r.text, "free snacks");
  assert.equal(r.tellsRejected.length, 3);
});

test("post-processing lowercases a Title Case candidate in a lowercase room", () => {
  const r = pickMostHuman(["My Cat's Tax Return."], lowerRoom, { existing: [], rng: mulberry32(1) });
  assert.ok(r);
  assert.equal(r.text, "my cat's tax return");
  assert.equal(r.from, "My Cat's Tax Return.");
});

test("post-processing adds a period, trims to maxLen, and caps typos", () => {
  const tidy: StyleStats = { medianLen: 20, maxLen: 25, lowerRate: 0, periodRate: 1, emojiRate: 0, exclaimRate: 0, typoRate: 1, lazyRate: 0 };
  const r = pickMostHuman(["My landlord and his three angry geese"], tidy, { existing: [], rng: mulberry32(5) });
  assert.ok(r);
  assert.ok(r.text.endsWith("."), r.text);
  assert.ok(r.text.length <= 27, r.text);
  const words = r.text.slice(0, -1).split(" "), orig = "My landlord and his three".split(" ");
  assert.equal(words.filter((w, i) => w !== orig[i]).length, 1, r.text); // exactly 1 typo under 40 chars
});

test("imitate breaks a tie toward the sampled style", () => {
  const r = pickMostHuman(["a goose", "my landlord"], lowerRoom, { existing: [], imitate: ["my landlord again"], rng: mulberry32(1) });
  assert.equal(r?.from, "my landlord");
});

test("scoreHuman penalises tells", () => {
  assert.ok(scoreHuman("my ex", lowerRoom) > scoreHuman("A Whimsical Tapestry Of Regret.", lowerRoom));
});

test("injectTypos respects rate 0 and rate 1", () => {
  const s = "the quick brown fox jumps over lazy dogs";
  assert.equal(injectTypos(s, 0, mulberry32(1)), s);
  const rng = mulberry32(2);
  for (let k = 0; k < 20; k++) {
    const out = injectTypos(s, 1, rng).split(" ");
    s.split(" ").forEach((w, i) => assert.notEqual(out[i], w, `word ${w} untouched in ${out.join(" ")}`));
  }
  assert.equal(injectTypos("ok no", 1, mulberry32(1)), "ok no"); // words under 3 letters are left alone
  assert.equal(injectTypos(s, 1, mulberry32(1), 1).split(" ").filter((w, i) => w !== s.split(" ")[i]).length, 1);
});

test("botDelayMs bounds", () => {
  const rng = mulberry32(11);
  const humans = [3000, 8000, 15000, 30000];
  for (let k = 0; k < 500; k++) {
    const d = botDelayMs(humans, 45000, rng);
    assert.ok(d >= 8000 && d <= 43500, String(d));
    assert.ok(Number.isInteger(d));
  }
  for (let k = 0; k < 200; k++) {
    const d = botDelayMs([5000], 40000, rng);
    assert.ok(d >= 14000 && d <= 24000, String(d));
  }
  assert.equal(botDelayMs([1000, 44000, 44500], 45000, rng), 43500); // cap wins over the 2nd human
  assert.ok(botDelayMs([], 2000, rng) <= 500);
});
