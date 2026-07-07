import { Frame } from "./ui/Frame";
import { Reveal } from "./ui/Reveal";

/**
 * The "in the wild" screenshot moment. Instead of a real image we render the
 * data claim as a Carto-report card: files indexed, routes, edges, domains.
 * The message: "this is a real number from a real session, not a marketing
 * stat." A quote from Claude Code sells the moment.
 */
export function InTheWild() {
  return (
    <section className="border-b border-line">
      <div className="shell grid items-center gap-12 py-20 md:grid-cols-[1fr_1fr] md:gap-16 md:py-28">
        <Reveal>
          <h2 className="max-w-xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-5xl">
            &ldquo;Touch that file and 22 things could break. That&apos;s
            exactly what you want to know before refactoring.&rdquo;
          </h2>
          <p className="mt-6 font-mono text-sm text-ink-3">
            — Claude Code, reviewing the supabase repo through Carto
          </p>
          <p className="mt-8 max-w-md text-[0.95rem] leading-relaxed text-ink-2">
            Real session, no editing. 5,974 files indexed in ~780ms, 86 routes,
            4,839 import edges, 7 domains. The AI worked with facts, not
            guesses.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <Frame className="bg-panel p-6 md:p-8">
            <div className="flex items-center justify-between border-b border-line pb-4">
              <div>
                <p className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ink-3">
                  live session
                </p>
                <p className="mt-1 font-mono text-[0.85rem] text-ink">
                  supabase/supabase
                </p>
              </div>
              <span className="border border-safe px-2.5 py-1 font-mono text-[0.7rem] uppercase tracking-[0.1em] text-safe">
                ● indexed
              </span>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-6">
              <Stat label="FILES" value="5,974" />
              <Stat label="ROUTES" value="86" />
              <Stat label="IMPORT EDGES" value="4,839" />
              <Stat label="DOMAINS" value="7" />
            </div>

            <div className="mt-6 border-t border-line pt-4">
              <p className="flex items-baseline justify-between font-mono text-[0.78rem] text-ink-2">
                <span>first index</span>
                <span className="text-ink">780ms</span>
              </p>
              <p className="mt-1.5 flex items-baseline justify-between font-mono text-[0.78rem] text-ink-2">
                <span>re-index (cached)</span>
                <span className="text-ink">218ms</span>
              </p>
              <p className="mt-1.5 flex items-baseline justify-between font-mono text-[0.78rem] text-ink-2">
                <span>validate_diff p50</span>
                <span className="text-ink">84 µs</span>
              </p>
            </div>
          </Frame>
        </Reveal>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
        {label}
      </p>
      <p className="mt-2 font-display text-3xl font-semibold leading-none text-ink">
        {value}
      </p>
    </div>
  );
}
