// Stand-in for shared/humanize.ts (Nelson is writing the tested version to the same spec).
// Same exported names and shapes, so switching is one import change in ./bots.ts.

export interface StyleStats {
  medianLen: number;
  maxLen: number;
  lowerRate: number;
  periodRate: number;
  emojiRate: number;
  exclaimRate: number;
  typoRate: number;
  lazyRate: number;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const rate = (xs: string[], f: (s: string) => boolean) => (xs.length ? xs.filter(f).length / xs.length : 0);

export function styleStats(answers: string[]): StyleStats {
  const a = answers.map((s) => s.trim()).filter(Boolean);
  const lens = a.map((s) => s.length).sort((x, y) => x - y);
  return {
    medianLen: lens.length ? lens[Math.floor(lens.length / 2)] : 28,
    maxLen: lens.length ? lens[lens.length - 1] : 60,
    lowerRate: a.length ? rate(a, (s) => s === s.toLowerCase()) : 0.6,
    periodRate: a.length ? rate(a, (s) => /\.$/.test(s)) : 0.1,
    emojiRate: rate(a, (s) => EMOJI.test(s)),
    exclaimRate: rate(a, (s) => s.includes("!")),
    typoRate: 0.2,
    lazyRate: a.length ? rate(a, (s) => s.split(/\s+/).length <= 2) : 0.2,
  };
}

const TELL_WORDS = /\b(delve|whimsical|tapestry|indeed|alas|perhaps|moreover|furthermore|quintessential|realm|as an ai)\b/i;

export function findTell(s: string, stats?: Pick<StyleStats, "maxLen">): string | null {
  if (/[—–]/.test(s)) return "dash";
  if (s.includes(";")) return "semicolon";
  if (/["“”]/.test(s)) return "quotes";
  if (/^(ah|well|oh|hmm),/i.test(s)) return "opener";
  if (TELL_WORDS.test(s)) return "word";
  if (stats && s.length > Math.max(24, stats.maxLen + 8)) return "too long";
  const words = s.split(/\s+/).filter((w) => /^[a-z]/i.test(w));
  if (words.length >= 3 && words.every((w) => /^[A-Z]/.test(w))) return "title case";
  return null;
}

const NEIGHBOURS: Record<string, string> = {
  a: "qs", b: "vn", c: "xv", d: "sf", e: "wr", f: "dg", g: "fh", h: "gj", i: "uo", j: "hk", k: "jl", l: "k",
  m: "n", n: "bm", o: "ip", p: "o", q: "w", r: "et", s: "ad", t: "ry", u: "yi", v: "cb", w: "qe", x: "zc", y: "tu", z: "x",
};

export function injectTypos(s: string, typoRate: number, rng: () => number = Math.random): string {
  if (rng() >= typoRate) return s;
  const words = s.split(" ");
  const idx = words.map((w, i) => (w.length > 3 && /^[a-z]+$/i.test(w) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return s;
  const wi = idx[Math.floor(rng() * idx.length)];
  const w = words[wi];
  const ci = 1 + Math.floor(rng() * (w.length - 2));
  const op = rng();
  let out: string;
  if (op < 0.35) out = w.slice(0, ci) + w[ci + 1] + w[ci] + w.slice(ci + 2); // swap
  else if (op < 0.6) out = w.slice(0, ci) + w.slice(ci + 1); // drop
  else if (op < 0.8) out = w.slice(0, ci) + w[ci] + w.slice(ci); // double
  else {
    const n = NEIGHBOURS[w[ci].toLowerCase()];
    out = n ? w.slice(0, ci) + n[Math.floor(rng() * n.length)] + w.slice(ci + 1) : w;
  }
  words[wi] = out;
  return words.join(" ");
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function pickMostHuman(
  candidates: string[],
  stats: StyleStats,
  opts: { existing: string[]; imitate?: string[]; rng?: () => number },
): string | null {
  const rng = opts.rng ?? Math.random;
  const seen = new Set(opts.existing.map(norm));
  const target = opts.imitate?.length ? styleStats(opts.imitate) : stats;
  const ok = candidates
    .map((c) => String(c ?? "").trim().replace(/\s+/g, " "))
    .filter((c) => c && !seen.has(norm(c)) && !findTell(c, target));
  if (!ok.length) return null;
  ok.sort((a, b) => Math.abs(a.length - target.medianLen) - Math.abs(b.length - target.medianLen));
  let s = ok[0];
  if (s.length > target.maxLen + 4) s = s.slice(0, target.maxLen + 4).replace(/\s+\S*$/, "");
  if (rng() < target.lowerRate) s = s.toLowerCase();
  if (/\.$/.test(s) && rng() > target.periodRate) s = s.slice(0, -1);
  if (s.includes("!") && rng() > Math.max(0.15, target.exclaimRate)) s = s.replace(/!+/g, "");
  return injectTypos(s, target.typoRate, rng);
}
