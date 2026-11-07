// Host-injected theme kit (PLAN.md idea 5): one base stylesheet the TV adds to every game bundle
// so hand-built and authored games share one look. It goes FIRST in the bundle's <head>, so the
// bundle's own CSS still wins; bundles stay network-free (the fonts are data: URLs) and use the
// variables:
//   --bg --surface --ink --muted --accent   palette, from meta.palette (a default when absent)
//   --font                                  "Satoshi", system-ui, sans-serif
//   --display --body --tiny                 the three text sizes on the 1920x1080 canvas
// plus html/body defaults and a :focus-visible ring in --accent.

export interface Palette {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
}

// Placeholder until Nelson's six palettes land in shared/ (asked on WhatsApp 15:45); every id
// maps to DEFAULT until then, so bundles that declare meta.palette already get a sane look.
export const DEFAULT_PALETTE: Palette = { bg: "#0B0F0C", surface: "#172019", ink: "#F2EFE6", muted: "#9AA79C", accent: "#E4572E" };
export const PALETTES: Record<string, Palette> = {};

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
  return (id && PALETTES[id]) || DEFAULT_PALETTE;
}

export async function themeCss(paletteId?: string): Promise<string> {
  const p = paletteFor(paletteId);
  return `${await fonts()}
:root{--bg:${p.bg};--surface:${p.surface};--ink:${p.ink};--muted:${p.muted};--accent:${p.accent};
--font:"Satoshi",system-ui,-apple-system,"Segoe UI",sans-serif;--display:96px;--body:44px;--tiny:28px}
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
