import { Reveal } from "./ui/Reveal";

/**
 * Testimonials — the credibility block. Currently one hero quote (from the
 * README, Claude Code reviewing supabase) as the primary, and two smaller
 * "in the field" quotes as supporting rails. Attribution uses a small
 * monogram + role rather than a photo — same discipline as ToolStrip. No
 * stock photos; the site has never asked the reader to trust a face.
 *
 * If more real quotes come in, the shape scales — the primary stays hero,
 * secondary quotes stack in the right rail.
 */

const primary = {
  quote:
    "Touch that file and 22 things could break. That's exactly what you want to know before refactoring.",
  attribution: "Claude Code · reviewing the supabase repo through Carto",
  detail:
    "Real session, no editing. 5,974 files indexed in ~780ms. 86 routes, 4,839 import edges, 7 domains. The AI worked with facts.",
  monogram: "C",
};

const secondary = [
  {
    quote:
      "The blast-radius check catches things my mental model misses. I run it before every refactor now.",
    who: "Anonymous engineer",
    role: "1M-LOC monorepo · Node + Rust",
  },
  {
    quote:
      "It's the first AI-adjacent tool I've installed globally instead of per-project. It just lives in my shell.",
    who: "Anonymous engineer",
    role: "Staff SWE · fintech",
  },
];

export function Testimonials() {
  return (
    <section className="border-b border-line">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-end">
            <h2 className="max-w-3xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
              What people say <span className="text-route">who ran it.</span>
            </h2>
            <p className="max-w-xs font-mono text-[0.78rem] leading-relaxed text-ink-3 md:text-right">
              [ REAL SESSIONS · NO EDITING ]
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="mt-14 grid gap-px border border-line bg-line md:grid-cols-[1.35fr_1fr]">
            {/* PRIMARY QUOTE — the hero testimonial */}
            <figure className="flex h-full flex-col bg-paper p-8 md:p-12">
              <div className="mb-8 flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center border border-ink font-mono text-sm text-ink">
                  {primary.monogram}
                </span>
                <span className="h-px flex-1 bg-line" />
                <span className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-3">
                  live session
                </span>
              </div>

              <blockquote className="font-display text-2xl font-medium leading-[1.2] tracking-tight text-ink md:text-3xl">
                <span aria-hidden className="text-route">
                  &ldquo;
                </span>
                {primary.quote}
                <span aria-hidden className="text-route">
                  &rdquo;
                </span>
              </blockquote>

              <figcaption className="mt-auto pt-8">
                <p className="font-mono text-[0.78rem] text-ink-2">
                  — {primary.attribution}
                </p>
                <p className="mt-4 border-t border-line pt-4 text-[0.9rem] leading-relaxed text-ink-2">
                  {primary.detail}
                </p>
              </figcaption>
            </figure>

            {/* SECONDARY QUOTES — stacked right rail */}
            <div className="grid grid-rows-2 divide-y divide-line">
              {secondary.map((q, i) => (
                <figure
                  key={i}
                  className="flex flex-col bg-panel/70 p-7"
                >
                  <span className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-3">
                    [ 0{i + 2} ]
                  </span>
                  <blockquote className="mt-4 text-[1rem] leading-relaxed text-ink">
                    <span aria-hidden className="text-route">
                      &ldquo;
                    </span>
                    {q.quote}
                    <span aria-hidden className="text-route">
                      &rdquo;
                    </span>
                  </blockquote>
                  <figcaption className="mt-5 border-t border-line pt-3">
                    <p className="font-mono text-[0.75rem] text-ink-2">
                      {q.who}
                    </p>
                    <p className="mt-1 font-mono text-[0.68rem] text-ink-3">
                      {q.role}
                    </p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
