import { Reveal } from "./ui/Reveal";

const legacy = [
  "Indexes once, forgets. Every session starts from zero.",
  "Answers by text or embedding similarity.",
  "No blast radius. No reverse-dep graph.",
  "Ships inside one editor's tool.",
  "Same generic answer each chat.",
];

const carto = [
  "Persistent facts + five layers of cross-session memory.",
  "Structural graph: imports, routes, models, domains.",
  "Sub-microsecond blast radius. Bitmap-backed.",
  "Auto-wires into every AI tool on your machine.",
  "Learns your invariants and conventions from the graph itself.",
];

/**
 * Legacy vs Carto — a hard positioning move. Names the incumbent category
 * ("a code index") as legacy and plants Carto in a new category ("the map").
 * Same shape as Supermemory's "Legacy: A Vector Database vs Supermemory".
 */
export function LegacyVsCarto() {
  return (
    <section className="border-b border-line">
      <div className="shell py-20 md:py-24">
        <Reveal>
          <h2 className="max-w-3xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
            The code index era is over.{" "}
            <span className="text-route">Carto is the map.</span>
          </h2>
          <p className="mt-6 max-w-2xl text-[1rem] leading-relaxed text-ink-2">
            Every AI tool has a code index. They re-build it every session, they
            forget what got decided, and they can&apos;t tell you what breaks
            if you touch a file. Different primitive, different math, different
            answer.
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="mt-12 grid gap-px border border-line bg-line md:grid-cols-2">
            {/* legacy */}
            <div className="flex flex-col bg-panel-2/40 p-7">
              <div className="mb-5 flex items-baseline gap-3">
                <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
                  legacy
                </span>
                <span className="h-px flex-1 bg-line" />
                <span className="font-mono text-[0.7rem] text-ink-3">
                  a code index
                </span>
              </div>
              <h3 className="font-display text-2xl font-medium leading-tight text-ink-2">
                Stores files. Returns files. Forgets on close.
              </h3>
              <ul className="mt-6 space-y-3">
                {legacy.map((line) => (
                  <li
                    key={line}
                    className="flex items-baseline gap-3 text-[0.9rem] leading-relaxed text-ink-2"
                  >
                    <span
                      aria-hidden
                      className="font-mono text-signal"
                    >
                      ×
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* carto */}
            <div className="flex flex-col bg-paper p-7">
              <div className="mb-5 flex items-baseline gap-3">
                <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-route">
                  carto
                </span>
                <span className="h-px flex-1 bg-line" />
                <span className="font-mono text-[0.7rem] text-ink-3">
                  the map
                </span>
              </div>
              <h3 className="font-display text-2xl font-medium leading-tight text-ink">
                A living graph your AI reads before writing.
              </h3>
              <ul className="mt-6 space-y-3">
                {carto.map((line) => (
                  <li
                    key={line}
                    className="flex items-baseline gap-3 text-[0.9rem] leading-relaxed text-ink"
                  >
                    <span aria-hidden className="font-mono text-route">
                      ■
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
