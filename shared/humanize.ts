// Make a bot's answer pass as human in "Who's the Bot?". Pure functions, no dependencies, no I/O.
// Runs on the TV host (not inside game bundles): a game posts
//   { type: "bot_answer", id, prompt, humans, imitate?, caught?, effort? }
// the host asks app.compose for 4 candidates, runs pickMostHuman(candidates, styleStats(humans), …)
// and replies { type: "ai_result", id, ok, data: { text } }.
//
// Only erasable TypeScript (types and interfaces), so `node shared/humanize.ts` runs as-is on Node 22.
// Every random choice goes through an injected `rng: () => number` in [0, 1); use mulberry32(seed)
// for reproducible tests and Math.random in production.

export type Rng = () => number;

/** Tiny seeded PRNG (mulberry32). Same seed, same sequence. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Style statistics of the room
// ---------------------------------------------------------------------------------------------

export interface StyleStats {
  /** Median answer length in characters (code points). */
  medianLen: number;
  /** Longest answer in characters. */
  maxLen: number;
  /** Share of answers with no uppercase letter at all. */
  lowerRate: number;
  /** Share of answers ending in a single '.' (an ellipsis "..." does not count). */
  periodRate: number;
  /** Share of answers containing at least one emoji (\p{Extended_Pictographic}). */
  emojiRate: number;
  /** Share of answers containing '!'. */
  exclaimRate: number;
  /** Rough share of words that look like typos. A heuristic, see looksLikeTypo. */
  typoRate: number;
  /** Share of answers that are ≤ 2 words or in LAZY_ANSWERS. */
  lazyRate: number;
}

/** What styleStats returns for an empty room: a casual phone-typing default. */
export const DEFAULT_STATS: StyleStats = {
  medianLen: 24, maxLen: 60, lowerRate: 0.7, periodRate: 0.1, emojiRate: 0.1, exclaimRate: 0.1, typoRate: 0.03, lazyRate: 0.15,
};

export const LAZY_ANSWERS = new Set(["idk", "idk lol", "lol", "no", "pass", "same"]);

const EMOJI = /\p{Extended_Pictographic}/u;
const UPPER = /\p{Lu}/u;

const len = (s: string) => [...s].length;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const endsWithPeriod = (s: string) => /[^.]\.$|^\.$/.test(s.trim());

/**
 * Small common-word list (casual English plus phone slang), apostrophes removed. Used only to tell
 * typos from real words; it is not a dictionary, so the typo heuristic only ever fires on words that
 * are one slip away from one of these.
 */
const COMMON = new Set(`
a about after again all also always am an and any are around as at away back bad be because been
before being best better big bit but by call came can cant come could cuz day did didnt do does doesnt
dog dont down eat else even ever every everything face fact feel few find first for friend from fun
get getting girl give go god going gone good got great guy had hand happy has have he head hear her
here him his home hot house how i if im in into is isnt it its ive just keep kid kind know last least
left let life like little live lol long look lot love made make man many maybe me mean mom more most
much must my name need never new next nice night no not nothing now of off oh ok okay old on once one
only or other our out over own party people person phone place play please pretty put really right
said same saw say see she should since so some something sorry still stop stuff such sure take talk
tell than thank thanks that thats the their them then there these they thing things think this those
though thought through time to today told too took tried try trying two up us use very wait want was
way we week well went were what when where which while who why will with wont work would wrong yeah
year yes yet you your youre dad mum mother father brother sister wife husband boyfriend girlfriend
cat car food pizza beer wine coffee water money job boss school teacher dentist doctor bed sleep tired
ex idk omg lmao tbh ngl gonna wanna gotta kinda ur u ya yep nope nah honestly literally actually
probably definitely totally basically funny weird dumb stupid cool awesome hate
`.trim().split(/\s+/));

const QWERTY = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const NEIGHBOURS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (let r = 0; r < 3; r++) for (let c = 0; c < QWERTY[r].length; c++) {
    let n = "";
    for (const [dr, dc] of [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, -1], [1, 0]]) {
      const ch = QWERTY[r + dr]?.[c + dc];
      if (ch) n += ch;
    }
    out[QWERTY[r][c]] = n;
  }
  return out;
})();

let typoForms: Set<string> | null = null;
/** Every adjacent-letter transposition and doubled-letter form of a common word that is not itself common. */
function getTypoForms(): Set<string> {
  if (typoForms) return typoForms;
  typoForms = new Set();
  for (const w of COMMON) {
    for (let i = 0; i < w.length - 1; i++) typoForms.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
    for (let i = 0; i < w.length; i++) typoForms.add(w.slice(0, i + 1) + w[i] + w.slice(i + 1));
  }
  for (const w of COMMON) typoForms.delete(w);
  return typoForms;
}

/**
 * Heuristic: a word looks like a typo when it is not in the common-word list but IS an adjacent-letter
 * transposition ("teh", "waht") or a doubled-letter slip ("thhe", "yeahh") of a common word. Misses
 * most real typos and catches a few real words; it only has to tell a sloppy room from a tidy one.
 */
export function looksLikeTypo(word: string): boolean {
  const w = word.toLowerCase().replace(/['’]/g, "").replace(/[^a-z]/g, "");
  return w.length >= 2 && !COMMON.has(w) && getTypoForms().has(w);
}

/** Measure how the humans in the room write. Empty and whitespace-only answers are ignored. */
export function styleStats(answers: string[]): StyleStats {
  const a = answers.map((s) => s.trim()).filter(Boolean);
  if (!a.length) return { ...DEFAULT_STATS };
  const share = (f: (s: string) => boolean) => a.filter(f).length / a.length;
  const lens = a.map(len).sort((x, y) => x - y);
  const mid = lens.length >> 1;
  const medianLen = lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
  const allWords = a.flatMap(words);
  return {
    medianLen,
    maxLen: lens[lens.length - 1],
    lowerRate: share((s) => !UPPER.test(s)),
    periodRate: share(endsWithPeriod),
    emojiRate: share((s) => EMOJI.test(s)),
    exclaimRate: share((s) => s.includes("!")),
    typoRate: allWords.length ? allWords.filter(looksLikeTypo).length / allWords.length : 0,
    lazyRate: share((s) => words(s).length <= 2 || LAZY_ANSWERS.has(s.toLowerCase())),
  };
}

// ---------------------------------------------------------------------------------------------
// Tells
// ---------------------------------------------------------------------------------------------

/**
 * Curated AI-tell vocabulary: words and phrases a party guest typing on a phone almost never uses but
 * a language model reaches for. Matched case-insensitively on word boundaries; ’ and ' are equivalent.
 * "I'm just" is narrowed to "I'm just a/an AI|bot|language model|program", because a bare "i'm just
 * tired" is a perfectly human answer.
 */
export const AI_TELL_WORDS: string[] = [
  "delve", "delves", "delving", "tapestry", "whimsical", "whimsy", "testament", "nuanced", "vibrant",
  "multifaceted", "it's worth noting", "as an ai", "as a language model", "language model",
  "i'm just an ai", "i'm just a bot", "i'm just a language model", "i'm just a program",
  "realm", "embark", "intricate", "furthermore", "moreover", "additionally", "elevate", "unleash",
  "ever-evolving", "bustling", "captivating", "enchanting", "symphony", "kaleidoscope", "plethora",
  "myriad", "resonate", "resonates", "paramount", "pivotal", "cacophony", "serendipity", "quintessential",
  "a dash of", "a sprinkle of", "a hint of", "picture this", "let's be honest", "in conclusion",
  "navigating the", "dive into", "sheer joy", "unapologetically", "ah yes", "ah, the",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TELL_WORD_RE = new RegExp(
  "(?<![\\p{L}])(" + AI_TELL_WORDS.map((w) => escapeRe(w).replace(/'/g, "['’]")).join("|") + ")(?![\\p{L}])", "iu");

/**
 * Interjection openers followed by punctuation ("Ah, …", "Well, …", "Indeed! …", "Alas, …",
 * "Certainly, …", "Absolutely! …") and leading stage-direction asterisks ("*sips tea*"). "well that's
 * awkward" (no punctuation) is fine; plain "oh," and "hmm" stay allowed because humans use them.
 */
const OPENER_RE = /^\s*(?:(ah+|well|indeed|alas|certainly|absolutely|behold|oh my)\s*[,!.…:—–]|\*)/i;
/** "Answer: …" / "Response: …" label prefixes. */
const LABEL_RE = /^\s*(?:my\s+)?(?:answer|response|reply)\s*:/i;
/** Emoticons that use a semicolon and are not one. */
const WINK_RE = /;-?[)pPD(]/g;

/**
 * Quote characters: any double quote (straight " or curly “ ” „ « »), and a single quote (' ‘ ’) that
 * is not an apostrophe. An apostrophe is a single quote right after a letter or digit (don't, don’t,
 * dogs') or one of the clipped forms 'cause 'em 'til 'bout '90s.
 */
function hasQuote(s: string): boolean {
  if (/["“”„«»]/.test(s)) return true;
  const t = s.replace(/(^|\s)['‘’](?:cause|cuz|em|til|bout|\d0s)\b/gi, "$1");
  return /(^|[^\p{L}\p{N}])['‘’]/u.test(t);
}

/**
 * Title case: a run of ≥ 3 consecutive Capitalised words (capital then lowercase, ≥ 2 letters) in a
 * lowercase-leaning room (stats.lowerRate ≥ 0.5). Without stats we cannot know the room, so it only
 * fires when every word of a ≥ 3-word answer is capitalised. "I" neither counts nor breaks a run.
 */
function titleCase(s: string, stats?: StyleStats): boolean {
  const ws = words(s).map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'’]+$/gu, "")).filter((w) => w && w !== "I");
  const cap = (w: string) => /^\p{Lu}[\p{Ll}'’]+$/u.test(w);
  if (!stats) return ws.length >= 3 && ws.every(cap);
  if (stats.lowerRate < 0.5) return false;
  let run = 0;
  for (const w of ws) { run = cap(w) ? run + 1 : 0; if (run >= 3) return true; }
  return false;
}

/**
 * "Too long": longer than 1.5 × stats.maxLen + 10 characters. The slack is deliberate: an answer a
 * little over the room's longest gets trimmed at a word boundary by pickMostHuman instead of thrown
 * away; only one that would lose most of itself to the trim counts as a tell. Needs stats; without
 * them the rule is skipped.
 */
function tooLong(s: string, stats?: StyleStats): string | null {
  if (!stats) return null;
  const n = len(s.trim());
  return n > stats.maxLen * 1.5 + 10 ? `too long (${n} chars, room max ${stats.maxLen})` : null;
}

/**
 * Why `s` reads as machine-written, or null when it passes. Checks, in order: em/en dash, semicolon
 * (winks like ;) excepted), quotes, interjection/asterisk openers, "Answer:" labels, AI-tell words,
 * too long vs stats.maxLen (needs stats), title case (see titleCase).
 */
export function findTell(s: string, stats?: StyleStats): string | null {
  if (/[—–]/.test(s)) return "em/en dash";
  if (s.replace(WINK_RE, "").includes(";")) return "semicolon";
  if (hasQuote(s)) return "quotes";
  const op = s.match(OPENER_RE);
  if (op) return `opener "${op[0].trim()}"`;
  if (LABEL_RE.test(s)) return "answer label";
  const w = s.match(TELL_WORD_RE);
  if (w) return `AI word "${w[1].toLowerCase()}"`;
  const tl = tooLong(s, stats);
  if (tl) return tl;
  if (titleCase(s, stats)) return "title case";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Typos
// ---------------------------------------------------------------------------------------------

/**
 * Give each word of ≥ 3 letters a typo with probability `rate`, at most `maxTypos` in total. A typo
 * is one of: neighbour-key substitution (a QWERTY neighbour, e.g. "party" → "partt"),
 * a dropped letter, a doubled letter. The first letter is never touched (people rarely miss it).
 */
export function injectTypos(s: string, rate: number, rng: Rng, maxTypos = Infinity): string {
  if (rate <= 0 || maxTypos <= 0) return s;
  let made = 0;
  return s.replace(/\p{L}{3,}/gu, (w) => {
    if (made >= maxTypos || rng() >= rate) return w;
    made++;
    const i = 1 + Math.floor(rng() * (w.length - 1));
    const op = Math.floor(rng() * 3);
    const ch = w[i];
    const nb = NEIGHBOURS[ch.toLowerCase()];
    if (op === 0 && nb) {
      let r = nb[Math.floor(rng() * nb.length)];
      if (ch !== ch.toLowerCase()) r = r.toUpperCase();
      return w.slice(0, i) + r + w.slice(i + 1);
    }
    if (op === 1) return w.slice(0, i) + w.slice(i + 1);
    return w.slice(0, i + 1) + ch + w.slice(i + 1);
  });
}

// ---------------------------------------------------------------------------------------------
// Scoring and picking
// ---------------------------------------------------------------------------------------------

const bin = (has: boolean, rate: number) => (has ? rate : 1 - rate) - 0.5;

function styleScore(text: string, stats: StyleStats): number {
  const n = len(text);
  return -1.5 * Math.abs(Math.log((n + 8) / (stats.medianLen + 8)))
    + bin(!UPPER.test(text), stats.lowerRate)
    + bin(endsWithPeriod(text), stats.periodRate)
    + bin(EMOJI.test(text), stats.emojiRate)
    + bin(text.includes("!"), stats.exclaimRate);
}

/**
 * How human `text` looks in this room: higher is more human. Closeness of length to medianLen
 * (log ratio) plus agreement with the room's case, trailing period, emoji and '!' habits, minus 3 if
 * findTell flags it. Not normalised; compare scores within one room only. The TV agent can sort the
 * round's answers by it to make its own guess (lowest = most bot-like).
 */
export function scoreHuman(text: string, stats: StyleStats): number {
  return styleScore(text, stats) - (findTell(text, stats) ? 3 : 0);
}

const norm = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean)), B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/**
 * Duplicate (equal after lowercasing and dropping punctuation) or near-duplicate: edit distance
 * ≤ 20% of the longer one, or ≥ 70% shared words when both have ≥ 2 words.
 */
function nearDuplicate(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  if (levenshtein(x, y) <= Math.floor(0.2 * Math.max(x.length, y.length))) return true;
  return x.includes(" ") && y.includes(" ") && jaccard(x, y) >= 0.7;
}

/** Trim to maxLen characters at a word boundary (hard cut if the boundary would lose over half). */
function trimTo(s: string, maxLen: number): string {
  const cs = [...s];
  if (cs.length <= maxLen) return s;
  const head = cs.slice(0, maxLen + 1).join("");
  const sp = head.lastIndexOf(" ");
  const cut = sp >= maxLen * 0.5 ? head.slice(0, sp) : cs.slice(0, maxLen).join("");
  return cut.replace(/[\s,;:—–-]+$/u, "");
}

/** Deterministic shaping to the room (no typos): trim, case, trailing period. */
function shape(raw: string, stats: StyleStats): { text: string; trimmed: boolean } {
  let t = raw.trim().replace(/\s+/g, " ");
  const before = t;
  t = trimTo(t, Math.max(8, Math.round(stats.maxLen)));
  const trimmed = t !== before;
  if (stats.lowerRate > 0.6) t = t.toLowerCase();
  if (stats.periodRate < 0.3 && endsWithPeriod(t)) t = t.slice(0, -1).trimEnd();
  else if (stats.periodRate > 0.8 && !/[.!?…]$/.test(t) && !EMOJI.test([...t].pop() ?? "")) t += ".";
  return { text: t, trimmed };
}

/** Strip one pair of wrapping quotes and an "Answer:" label: model formatting, not content. */
function unwrap(s: string): string {
  let t = s.trim().replace(LABEL_RE, "").trim();
  const m = t.match(/^["“'‘](.*)["”'’]$/s);
  if (m && !/["“”]/.test(m[1])) t = m[1].trim();
  return t;
}

export interface PickOptions {
  /** Answers already in the round (humans, other bots). Duplicates and near-duplicates are rejected. */
  existing: string[];
  /** Sample answers to resemble (e.g. one player's past answers); adds a similarity bonus. */
  imitate?: string[];
  rng: Rng;
}

export interface Picked {
  /** The answer to submit: shaped to the room, with typos. */
  text: string;
  /** The candidate it came from, verbatim. */
  from: string;
  score: number;
  /** One "reason: candidate" line per rejected candidate. */
  tellsRejected: string[];
}

/**
 * Choose the candidate most likely to pass as human, or null when every one fails.
 *
 * 1. Unwrap model formatting (one pair of wrapping quotes, an "Answer:" label).
 * 2. Reject: empty; too long vs stats.maxLen (checked on the raw candidate, before any trim);
 *    duplicate/near-duplicate of `existing`; any other tell, checked on the shaped text, so a Title
 *    Case candidate in a room that gets lowercased anyway is fixed rather than rejected.
 * 3. Score survivors with scoreHuman's style terms on the shaped text, −0.5 if it had to be trimmed,
 *    plus up to +1.5 for resembling the closest `imitate` sample (shared words + similar length).
 * 4. Post-process the winner: lowercase when lowerRate > 0.6; strip a trailing period when
 *    periodRate < 0.3, add one when > 0.8; trim to maxLen at a word boundary; inject typos at
 *    stats.typoRate (at most 1 under 40 chars, 1 per 40 chars beyond).
 * Ties keep the earlier candidate.
 */
export function pickMostHuman(candidates: string[], stats: StyleStats, opts: PickOptions): Picked | null {
  const tellsRejected: string[] = [];
  let best: { from: string; text: string; score: number } | null = null;
  for (const from of candidates) {
    const raw = unwrap(String(from ?? ""));
    if (!raw) { tellsRejected.push(`empty: ${from}`); continue; }
    const long = tooLong(raw, stats);
    if (long) { tellsRejected.push(`${long}: ${from}`); continue; }
    const { text, trimmed } = shape(raw, stats);
    const dup = opts.existing.find((e) => e && nearDuplicate(text, e));
    if (dup !== undefined) { tellsRejected.push(`duplicate of "${dup}": ${from}`); continue; }
    const tell = findTell(text, stats);
    if (tell) { tellsRejected.push(`${tell}: ${from}`); continue; }
    let score = styleScore(text, stats) - (trimmed ? 0.5 : 0);
    if (opts.imitate?.length) {
      const nt = norm(text);
      score += Math.max(...opts.imitate.map((m) => {
        const nm = norm(m), a = len(nt), b = len(nm);
        return jaccard(nt, nm) + 0.5 * (1 - Math.abs(a - b) / Math.max(a, b, 1));
      }));
    }
    if (!best || score > best.score) best = { from, text, score };
  }
  if (!best) return null;
  const n = len(best.text);
  const maxTypos = n < 40 ? 1 : Math.ceil(n / 40);
  const text = injectTypos(best.text, stats.typoRate, opts.rng, maxTypos);
  return { text, from: best.from, score: best.score, tellsRejected };
}

// ---------------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------------

/**
 * When the bot should submit, in ms from the round opening. With ≥ 2 human times: one of the human
 * times other than the fastest, picked at random, jittered ±15%, and never before the 2nd-fastest
 * human (so the bot is never first). With fewer: uniform in 35–60% of windowMs. Always capped at
 * windowMs − 1500 ms (the cap wins if the 2nd human was later than that). Integer ms, ≥ 0.
 * Human times are usually last round's (this round's are not known yet when the bot is asked).
 */
export function botDelayMs(humanTimesMs: number[], windowMs: number, rng: Rng): number {
  const hi = Math.max(0, windowMs - 1500);
  const ts = humanTimesMs.filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  let t: number;
  if (ts.length < 2) t = windowMs * (0.35 + 0.25 * rng());
  else {
    const pool = ts.slice(1);
    t = pool[Math.floor(rng() * pool.length)] * (0.85 + 0.3 * rng());
    t = Math.max(ts[1], t);
  }
  return Math.round(Math.min(hi, Math.max(0, t)));
}
