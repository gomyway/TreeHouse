import { useEffect, useRef } from "react";
import type { Player } from "../room/model";
import type { GameMeta } from "../game/catalog";
import { seatFor, seatSrc, validSeats } from "../game/seats";
import { paletteFor } from "../game/theme";
import { Qr } from "./Qr";

export function StatusPill({ status }: { status: string }) {
  const label = { connecting: "Opening room…", open: "Room open", reconnecting: "Reconnecting…", offline: "Offline" }[status] ?? status;
  return (
    <div className={`pill pill-${status}`} data-little="readout" data-little-label="Room status" data-little-data={JSON.stringify({ status })}>
      <i /> {label}
    </div>
  );
}

export function Lobby({
  code,
  joinUrl,
  players,
  status,
  games,
  focus,
  onPick,
}: {
  code: string | null;
  joinUrl: string | null;
  players: Player[];
  status: string;
  games: GameMeta[];
  focus: number;
  onPick: (g: GameMeta) => void;
}) {
  const shortUrl = joinUrl?.replace(/^https?:\/\//, "").replace(/\/?\?c=.*$/, "");
  // One focus system: the browser's own focus follows our remote focus index, so the TV never
  // shows two highlighted tiles (its native ring on one, ours on another).
  const tiles = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    tiles.current[focus]?.focus({ preventScroll: true });
  }, [focus, games.length]);

  // Preview the focused game: its palette washes over the lobby (the app's own tokens are
  // re-pointed at the game's on :root, with CSS transitions), its hook shows large, and the room is
  // drawn in its seats. Leaving the lobby restores the app palette.
  const shown = games;
  const fg = shown.length ? shown[Math.min(focus, shown.length - 1)] : undefined;
  const seats = validSeats(fg?.seats);
  useEffect(() => {
    if (!fg) return;
    const p = paletteFor(fg.palette);
    const root = document.documentElement.style;
    const vars: Record<string, string> = {
      "--bg": p.bg, "--bg-2": p.bg, "--card": p.surface, "--ink": p.ink, "--ink-2": p.ink, "--ink-3": p.muted,
      "--accent": p.accent, "--leaf": p.accent, "--line": `color-mix(in srgb, ${p.muted} 35%, transparent)`,
    };
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.removeProperty(k);
    };
  }, [fg?.id, fg?.palette]);
  return (
    <main className="lobby" data-little="region" data-little-label="Lobby">
      <div className="lobby-left">
        <section
          className="join card"
          data-little="readout"
          data-little-label="How to join"
          data-little-data={JSON.stringify({ code, joinUrl, players: players.length })}
        >
          {joinUrl && code ? (
            <>
              <Qr value={joinUrl} size={300} />
              <div className="join-text">
                <div className="eyebrow">Grab your phone</div>
                <div className="join-line">
                  Scan, or go to <b>{shortUrl}</b>
                </div>
                <div className="eyebrow">and enter</div>
                <div className="code" aria-label={`Room code ${code.split("").join(" ")}`}>
                  {code.split("").map((ch, i) => (
                    <span key={i}>{ch}</span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="join-wait">{status === "offline" ? "Can't reach the room server." : "Opening a room…"}</div>
          )}
        </section>

        <section className="games card" data-little="region" data-little-label="Games">
          <div className="eyebrow">Games · {games.length}</div>
          {games.length ? (
            <div className="game-browser">
              <div className="roller">
                <ul className="roller-list" style={{ ["--f" as string]: Math.min(focus, games.length - 1) }}>
                  {games.map((g, i) => (
                    <li
                      key={g.id}
                      ref={(el) => {
                        tiles.current[i] = el;
                      }}
                      tabIndex={i === focus ? 0 : -1}
                      className={`game-tile${i === focus ? " focused" : ""}`}
                      style={{ ["--d" as string]: Math.min(3, Math.abs(i - focus)) }}
                      data-little="item"
                      data-little-id={g.id}
                      data-little-action="start_game"
                      data-little-label={g.title}
                      data-little-order={i + 1}
                      data-little-data={JSON.stringify({ players: `${g.minPlayers ?? 1}-${g.maxPlayers ?? 12}` })}
                      onClick={() => onPick(g)}
                    >
                      <i className="dot" style={{ background: paletteFor(g.palette).accent }} />
                      <b>{g.title}</b>
                    </li>
                  ))}
                </ul>
              </div>
              {fg ? (
                <div
                  className="game-detail"
                  key={fg.id}
                  data-little="readout"
                  data-little-label="Focused game"
                  data-little-data={JSON.stringify({ title: fg.title, hook: fg.hook ?? null, description: fg.description })}
                >
                  <div className="detail-title">{fg.title}</div>
                  {fg.hook ? <div className="game-hook">{fg.hook}</div> : null}
                  <p className="detail-desc">{fg.description}</p>
                  <div className="detail-chips">
                    <span>
                      {fg.minPlayers ?? 1}–{fg.maxPlayers ?? 12} players
                    </span>
                    <span>{fg.phonesRequired === false ? "Camera game" : "Phones"}</span>
                    {fg.palette ? <span>{fg.palette}</span> : null}
                  </div>
                  <div className="detail-go">Press OK to play</div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty small">Loading games…</div>
          )}
        </section>
      </div>

      <section className="players card" data-little="region" data-little-label="Players">
        <div className="players-head">
          <span className="eyebrow">In the room</span>
          <span className="count" data-little="readout" data-little-label="Player count" data-little-data={JSON.stringify({ value: players.length })}>
            {players.length}
          </span>
        </div>
        <Couch players={players} seats={seats} gameKey={fg?.id ?? ""} />
        <div className="hint">Say “play Who’s the Bot” or “make a game where…”</div>
      </section>
    </main>
  );
}

// An oversized round armchair (a low drum base, a thick puffy seat cushion with piping, rounded
// arms wrapping the sides); the players sit where its throw pillows would, fanned along the back.
// Drawn in currentColor so it takes the focused game's accent; shading is black/white overlays and a
// bouclé dot texture.
function CloudCouch() {
  return (
    <svg className="couch-art" viewBox="0 0 600 300" aria-hidden="true">
      <defs>
        <pattern id="lr-boucle" width="9" height="9" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.4" fill="#fff" opacity=".12" />
          <circle cx="6.5" cy="6" r="1.2" fill="#000" opacity=".08" />
        </pattern>
      </defs>
      <ellipse cx="300" cy="284" rx="258" ry="13" fill="#000" opacity=".32" />
      {/* the round back, seen from the front: mostly hidden behind the people */}
      <ellipse cx="300" cy="158" rx="252" ry="100" fill="currentColor" />
      <ellipse cx="300" cy="150" rx="212" ry="70" fill="#000" opacity=".2" />
      {/* drum base */}
      <path d="M58 196 L58 236 A242 44 0 0 0 542 236 L542 196 Z" fill="currentColor" />
      <path d="M58 196 L58 236 A242 44 0 0 0 542 236 L542 196 Z" fill="#000" opacity=".1" />
      <path d="M58 236 A242 44 0 0 0 542 236" stroke="#000" strokeOpacity=".18" strokeWidth="6" fill="none" />
      {/* arms wrapping the sides */}
      <ellipse cx="92" cy="176" rx="44" ry="66" fill="currentColor" />
      <ellipse cx="508" cy="176" rx="44" ry="66" fill="currentColor" />
      <ellipse cx="84" cy="160" rx="22" ry="34" fill="#fff" opacity=".1" />
      <ellipse cx="516" cy="160" rx="22" ry="34" fill="#fff" opacity=".1" />
      {/* the puffy seat cushion */}
      <path d="M78 202 Q74 158 300 154 Q526 158 522 202 Q520 236 300 238 Q80 236 78 202 Z" fill="currentColor" />
      <ellipse cx="300" cy="180" rx="196" ry="20" fill="#fff" opacity=".16" />
      <path d="M84 208 Q300 230 516 208" stroke="#fff" strokeOpacity=".28" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M96 234 Q300 252 504 234" stroke="#000" strokeOpacity=".22" strokeWidth="4" fill="none" strokeLinecap="round" />
      <ellipse cx="300" cy="158" rx="252" ry="100" fill="url(#lr-boucle)" />
      <path d="M58 196 L58 236 A242 44 0 0 0 542 236 L542 196 Z" fill="url(#lr-boucle)" />
    </svg>
  );
}

/** Pillow spots: seats rest on the back of the cushion between the arms, fanned like the
 *  armchair's throw pillows (the middle sits highest, the ends lean out). In % of the couch box. */
function sag(n: number, i: number) {
  const pos = i % 4;
  const off = pos - (n - 1) / 2; // -1.5 .. 1.5
  const t = off / 3; // -0.5 .. 0.5
  return {
    left: `${50 + off * 17}%`,
    top: `${37 + 22 * t * t}%`,
    rotate: `${(t * 22).toFixed(1)}deg`,
  };
}

/** The room as a couch: round seats on the cushions, empty ones inviting people to join. */
function Couch({ players, seats, gameKey }: { players: Player[]; seats: ReturnType<typeof validSeats>; gameKey: string }) {
  const MAX = 8;
  const shown = players.slice(0, MAX);
  const slots = Math.min(MAX, Math.max(4, shown.length + (shown.length < MAX ? 1 : 0)));
  // One couch seats four; a fifth player brings out a second couch.
  const rows = slots > 4 ? [4, slots - 4] : [slots];
  let k = 0;
  return (
    <div className={`couch couches-${rows.length}`}>
      {rows.map((n, r) => (
        <div key={r} className="sofa">
          <ul className="couch-row">
            {Array.from({ length: n }, () => {
              const i = k++;
              const p = shown[i];
              const arc = sag(n, i);
              if (!p) {
                return (
                  <li key={`empty-${i}`} className="seat-slot empty" style={arc}>
                    <span className="ring">Join!</span>
                  </li>
                );
              }
              const seat = seatFor(p, seats);
              return (
                <li
                  key={p.id}
                  className="seat-slot"
                  data-little="item"
                  data-little-id={p.id}
                  data-little-label={p.name}
                  data-little-order={i + 1}
                  style={{ ["--c" as string]: p.color, ...arc }}
                >
                  <span className="ring">
                    {seat ? (
                      <img key={`${gameKey}-${seat.name}`} src={seatSrc(seat, p.color)} alt={seat.name} title={seat.name} />
                    ) : (
                      <b>{p.name.slice(0, 1).toUpperCase()}</b>
                    )}
                  </span>
                  <span className="seat-name">{p.name}</span>
                </li>
              );
            })}
          </ul>
          <CloudCouch />
        </div>
      ))}
      {players.length > MAX ? <div className="couch-more">+{players.length - MAX} more on the floor</div> : null}
    </div>
  );
}
