// Themed player seats (PLAN.md, Nelson 16:00): a game's meta.seats is 6-12 inline SVG icons
// (viewBox 0 0 48 48, drawn in currentColor). Each player gets one, stable across sessions when the
// phone has a guid. Seats are rendered as <img src="data:image/svg+xml,…"> with currentColor baked
// in: an authored SVG can never run script inside the TV app that way.

export interface Seat {
  name: string;
  svg: string;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The seat for a player: keyed on the guid when present, else the room's player id. */
export function seatFor<T extends { id: string; guid?: string }>(player: T, seats: Seat[] | undefined): Seat | null {
  if (!seats?.length) return null;
  return seats[hash(player.guid || player.id) % seats.length];
}

/** An <img>-safe data URL of the seat drawn in the given colour. */
export function seatSrc(seat: Seat, color: string): string {
  let svg = seat.svg.trim().replace(/currentColor/g, color);
  if (!/^<svg[\s>]/i.test(svg)) svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${svg}</svg>`;
  else if (!/xmlns=/.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Only well-formed seat lists: a name and an <svg> each, at most 12. */
export function validSeats(v: unknown): Seat[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((s): s is Seat => !!s && typeof (s as Seat).name === "string" && typeof (s as Seat).svg === "string" && /<svg[\s>]/i.test((s as Seat).svg))
    .slice(0, 12);
  return out.length ? out : undefined;
}
