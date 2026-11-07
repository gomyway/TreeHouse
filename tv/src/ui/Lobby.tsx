import { useEffect, useRef } from "react";
import type { Player } from "../room/model";
import type { GameMeta } from "../game/catalog";
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
          <div className="eyebrow">Games</div>
          {games.length ? (
            <ul className="game-row">
              {games.slice(0, 4).map((g, i) => (
                <li
                  key={g.id}
                  ref={(el) => {
                    tiles.current[i] = el;
                  }}
                  tabIndex={i === focus ? 0 : -1}
                  className={`game-tile${i === focus ? " focused" : ""}`}
                  data-little="item"
                  data-little-id={g.id}
                  data-little-action="start_game"
                  data-little-label={g.title}
                  data-little-order={i + 1}
                  data-little-data={JSON.stringify({ players: `${g.minPlayers ?? 1}-${g.maxPlayers ?? 12}` })}
                  onClick={() => onPick(g)}
                >
                  <b>{g.title}</b>
                  <span>{g.description}</span>
                </li>
              ))}
            </ul>
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
        {players.length ? (
          <ul className="player-grid">
            {players.map((p, i) => (
              <li
                key={p.id}
                className="player"
                data-little="item"
                data-little-id={p.id}
                data-little-label={p.name}
                data-little-order={i + 1}
                style={{ ["--c" as string]: p.color }}
              >
                <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="name">{p.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">Waiting for the first player…</div>
        )}
        <div className="hint">Say “play Who’s the Bot” or “make a game where…”</div>
      </section>
    </main>
  );
}
