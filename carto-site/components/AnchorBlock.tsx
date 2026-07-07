import { Reveal } from "./ui/Reveal";

/**
 * AnchorBlock — the second colour anchor. A full-bleed route-blue slab
 * roughly two-thirds down the page. This is Carto's version of Supermemory's
 * "<300ms · 100B+ · #1" solid-blue card: one giant claim, three supporting
 * numbers, one paper-inverse CTA. Nothing else on the page uses this much
 * unbroken blue — that's the point.
 */
export function AnchorBlock() {
  return (
    <section className="relative overflow-hidden border-b border-line bg-route text-paper">
      <div className="pointer-events-none absolute inset-0 bp-grid-blue" />

      {/* an oversized decorative wordmark, tucked into the corner */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-8 -bottom-16 select-none font-display font-semibold leading-[0.8] tracking-[-0.06em] text-paper/[0.07]"
        style={{ fontSize: "clamp(9rem, 22vw, 22rem)" }}
      >
        map.
      </div>

      <div className="shell relative py-20 md:py-28">
        <Reveal>
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-paper/60">
            [ THE PAYOFF ]
          </p>
          <h2 className="mt-6 max-w-3xl font-display text-4xl font-medium leading-[1.02] tracking-tight text-paper md:text-6xl">
            Sub-millisecond blast radius,{" "}
            <span className="opacity-70">every diff.</span>
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-paper/85">
            Every proposed patch triggers a reflex —{" "}
            <span className="font-mono text-paper">validate_diff</span>{" "}
            returns HIGH/MEDIUM/LOW in microseconds, so risky diffs get
            blocked before they reach your screen.
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="mt-14 grid grid-cols-2 gap-6 border-t border-paper/15 pt-10 md:mt-16 md:grid-cols-4 md:pt-14">
            <BigStat value="84 µs" label="VALIDATE_DIFF · P50" caption="budget was 5 ms" />
            <BigStat value="7,567" label="FILES · VSCODE" caption="held sub-ms at 50K" />
            <BigStat value="10.7×" label="MEDIAN SPEEDUP" caption="vs SQLite baseline" />
            <BigStat value="0" label="DIFFS SHIPPED BLIND" caption="if you want" />
          </div>
        </Reveal>

        <Reveal delay={0.14}>
          <div className="mt-12 flex flex-wrap items-center gap-4">
            <a
              href="/scan"
              className="group inline-flex h-12 items-center gap-2 border border-paper bg-paper px-6 text-sm font-medium text-route transition-colors hover:bg-transparent hover:text-paper"
            >
              Run Carto on a repo
              <span
                aria-hidden
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </a>
            <a
              href="https://github.com/theanshsonkar/carto"
              className="group inline-flex h-12 items-center gap-2 border border-paper/30 px-6 text-sm font-medium text-paper transition-colors hover:border-paper hover:bg-paper/[0.06]"
            >
              Read the code on GitHub
              <span
                aria-hidden
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function BigStat({
  value,
  label,
  caption,
}: {
  value: string;
  label: string;
  caption: string;
}) {
  return (
    <div>
      <p className="font-display font-semibold leading-none tracking-[-0.03em] text-paper text-4xl md:text-5xl">
        {value}
      </p>
      <p className="mt-4 font-mono text-[0.7rem] tracking-[0.14em] text-paper/80">
        {label}
      </p>
      <p className="mt-2 font-mono text-[0.72rem] leading-relaxed text-paper/60">
        {caption}
      </p>
    </div>
  );
}
