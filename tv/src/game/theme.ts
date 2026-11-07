// Host-injected theme kit (PLAN.md idea 5): one base stylesheet the TV adds to every game bundle
// so hand-built and authored games share one look. It goes FIRST in the bundle's <head>, so the
// bundle's own CSS still wins; bundles stay network-free (the fonts are data: URLs) and use the
// variables:
//   --bg --surface --ink --muted --accent   palette, from meta.palette (a default when absent)
//   --font                                  "Satoshi", system-ui, sans-serif
//   --display --body --tiny                 the three text sizes (10vh / 4vh / 2.4vh, shared/palettes.json)
// plus html/body defaults and a :focus-visible ring in --accent.

import kit from "../../../shared/palettes.json";

export interface Palette {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
}

// --surface is one step off --bg: 7% toward white on dark palettes, toward black on light ones.
function surfaceOf(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const light = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.5;
  const out = rgb.map((c) => Math.round(light ? c * 0.93 : c + (255 - c) * 0.07));
  return "#" + out.map((c) => c.toString(16).padStart(2, "0")).join("");
}

// The six palettes of the authored-game kit (shared/palettes.json, same as the runner's CONTRACT.md).
export const PALETTES: Record<string, Palette> = Object.fromEntries(
  Object.entries(kit.palettes).map(([id, p]) => [id, { bg: p.bg, ink: p.ink, muted: p.muted, accent: p.accent, surface: surfaceOf(p.bg) }]),
);
export const DEFAULT_PALETTE: Palette = PALETTES[kit.default] ?? Object.values(PALETTES)[0];

let fontCss: Promise<string> | null = null;

async function dataUrl(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:font/woff2;base64,${btoa(bin)}`;
}

/** @font-face rules for Satoshi 400/500/700 as data: URLs, built once. Empty on failure. */
function fonts(): Promise<string> {
  fontCss ??= Promise.all(
    [400, 500, 700].map(async (w) => {
      const url = await dataUrl(`./fonts/Satoshi-${w}.woff2`);
      return `@font-face{font-family:"Satoshi";font-weight:${w};font-style:normal;font-display:block;src:url(${url}) format("woff2")}`;
    }),
  )
    .then((rules) => rules.join("\n"))
    .catch((e) => {
      console.warn("[theme] fonts unavailable", String(e));
      fontCss = null; // try again next game
      return "";
    });
  return fontCss;
}

export function paletteFor(id?: string): Palette {
  if (!id) return DEFAULT_PALETTE;
  const key = Object.keys(PALETTES).find((k) => k.toLowerCase() === id.toLowerCase());
  return key ? PALETTES[key] : DEFAULT_PALETTE;
}

export async function themeCss(paletteId?: string): Promise<string> {
  const p = paletteFor(paletteId);
  return `${await fonts()}
:root{--bg:${p.bg};--surface:${p.surface};--ink:${p.ink};--muted:${p.muted};--accent:${p.accent};
--font:${kit.type.font};--display:${kit.type.display};--body:${kit.type.body};--tiny:${kit.type.tiny}}
html,body{background:var(--bg);color:var(--ink);font-family:var(--font)}
:focus-visible{outline:6px solid var(--accent);outline-offset:4px}`;
}

/** Puts the theme <style> first in the bundle's <head> (or at the very top if it has none). */
export async function injectTheme(html: string, paletteId?: string): Promise<string> {
  const tag = `<style data-host-theme>${await themeCss(paletteId)}</style>`;
  const m = html.match(/<head[^>]*>/i);
  if (m && m.index !== undefined) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  return tag + html;
}
