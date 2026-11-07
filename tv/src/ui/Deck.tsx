import { SLIDES } from "../deck/deck";

// Full-screen presenter: one 1920x1080 slide at a time, with a small counter. The remote's
// left/right move between slides (handled in App), Back leaves.
export function Deck({ index }: { index: number }) {
  const s = SLIDES[Math.max(0, Math.min(SLIDES.length - 1, index))];
  return (
    <main
      className="deck"
      data-little="region"
      data-little-label="Presentation"
      data-little-data={JSON.stringify({ slide: s.n, of: SLIDES.length, title: s.title })}
    >
      <div key={s.id} className="deck-canvas" dangerouslySetInnerHTML={{ __html: s.html }} />
      <div className="deck-counter" data-little="readout" data-little-label="Slide" data-little-data={JSON.stringify({ slide: s.n, of: SLIDES.length })}>
        {s.n} / {SLIDES.length}
      </div>
    </main>
  );
}
