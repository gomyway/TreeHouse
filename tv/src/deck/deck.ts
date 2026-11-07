// The Little Redwood pitch deck, presented on the TV by the TV app itself.
// Slides are the same files as the shared Slides artifact (tv/src/deck/slides/*.html: one
// <section> each, inline styles, a 1920x1080 canvas). The few deck-only tags become plain HTML
// here: <x-icon> → an emoji, <x-shape kind="arrow-*"> → an arrow glyph; the <aside> speaker notes
// are pulled out so the agent can narrate them.

const files = import.meta.glob("./slides/*.html", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const ORDER = ["cover", "kids", "parents", "what", "bot", "says", "statement", "how", "ladder", "safe", "memories", "built", "next"];

const ICONS: Record<string, string> = {
  Chat: "💬", CheckCircle: "✅", Code: "💻", Home: "🏠", Lightbulb: "💡", Lock: "🔒", Play: "▶️", Users: "👪", Verified: "🛡️",
  Star: "⭐", Clock: "⏱️", Globe: "🌍", Trust: "🤝", Tool: "🛠️",
};
const ARROWS: Record<string, string> = { "arrow-right": "→", "arrow-left": "←", "arrow-up": "↑", "arrow-down": "↓" };

export interface Slide {
  id: string;
  n: number;
  title: string;
  html: string;
  notes: string;
}

const px = (style: string, prop: string, d: number) => {
  const m = style.match(new RegExp(`${prop}\\s*:\\s*(\\d+)px`));
  return m ? Number(m[1]) : d;
};
const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function adapt(raw: string): { html: string; notes: string } {
  let notes = "";
  let html = raw.replace(/<aside>([\s\S]*?)<\/aside>/, (_, t: string) => {
    notes = strip(t);
    return "";
  });
  html = html.replace(/<x-icon name="([A-Za-z]+)" style="([^"]*)"><\/x-icon>/g, (_, name: string, style: string) => {
    const h = px(style, "height", 56);
    return `<span aria-hidden="true" style="display:block;font-size:${Math.round(h * 0.85)}px;line-height:1;width:${h}px;height:${h}px">${ICONS[name] ?? "•"}</span>`;
  });
  html = html.replace(/<x-shape kind="([a-z-]+)" style="([^"]*)"><\/x-shape>/g, (_, kind: string, style: string) => {
    const color = style.match(/background:\s*(#[0-9A-Fa-f]{3,8})/)?.[1] ?? "#F2A65A";
    const align = /align-self:\s*center/.test(style) ? "align-self:center;" : "";
    return `<span aria-hidden="true" style="${align}font-size:64px;font-weight:700;line-height:1;color:${color}">${ARROWS[kind] ?? "•"}</span>`;
  });
  // Slides use the deck's default text margins of zero; keep block elements tight like the editor does.
  html = html.replace(/<section /, '<section class="deck-slide" ');
  return { html, notes };
}

export const SLIDES: Slide[] = ORDER.map((id, i) => {
  const raw = files[`./slides/${id}.html`] ?? `<section id="${id}" style="background:#10201A;color:#F6F1E7;padding:128px"><h2>Missing slide ${id}</h2></section>`;
  const { html, notes } = adapt(raw);
  const h = raw.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/);
  return { id, n: i + 1, title: h ? strip(h[1]) : id, html, notes };
});

export function findSlide(q: string | number | undefined): number | null {
  if (q == null || q === "") return null;
  const n = Number(q);
  if (Number.isInteger(n) && n >= 1 && n <= SLIDES.length) return n - 1;
  const s = String(q).toLowerCase();
  const i = SLIDES.findIndex((x) => x.id === s || x.title.toLowerCase().includes(s));
  return i >= 0 ? i : null;
}
