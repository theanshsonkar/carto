import { Reveal } from "./ui/Reveal";

/**
 * StatsBand — the first rhythm break. Full-bleed dark surface, four enormous
 * stats. Sits directly after the hero and does the job Supermemory does with
 * their cinematic dark banner: interrupt the paper-white flow with weight.
 *
 * The numbers are the ones we lead with in the README — sub-millisecond
 * blast radius, 6K-file re-index, 9 tools wired, and one file on disk.
 */
export function StatsBand() {
  return (
    <section className="relative overflow-hidden border-b border-line bg-night text-night-text">
      {/* faint dark drafting grid so the section still reads as a Carto surface */}
      <div className="pointer-events-none absolute inset-0 bp-grid-dark opacity-60" />

      {/* a hint of route-blue vignette at the edges — the "map is glowing" cue */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 60% at 50% 100%, rgba(31,79,214,0.22), transparent 70%)",
        }}
      />

      <div className="shell relative py-16 md:py-24">
        <Reveal>
          <div className="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-night-muted">
              [ THE NUMBERS ]
            </p>
            <p className="max-w-md font-mono text-[0.78rem] leading-relaxed text-night-muted md:text-right">
              Measured on real open-source repos. M-series · 8 CPU · 8 GB.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-2 gap-8 border-t border-night-line pt-10 md:mt-14 md:grid-cols-4 md:gap-6 md:pt-14">
            <Stat
              value="2.7 µs"
              label="BLAST RADIUS · P50"
              caption="10.7× faster than SQLite"
            />
            <Stat
              value="967 ms"
              label="RE-INDEX · 6K FILES"
              caption="on supabase/supabase"
              route
            />
            <Stat
              value="9"
              label="AI TOOLS WIRED"
              caption="Cursor · Claude · Codex · Kiro · Zed · +4"
            />
            <Stat
              value="0 kb"
              label="OVER THE WIRE"
              caption="One SQLite file. Local only."
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Stat({
  value,
  label,
  caption,
  route = false,
}: {
  value: string;
  label: string;
  caption: string;
  route?: boolean;
}) {
  return (
    <div>
      <p
        className={`font-display font-semibold leading-none tracking-[-0.03em] ${
          route ? "text-night-route" : "text-night-text"
        } text-4xl md:text-6xl`}
      >
        {value}
      </p>
      <p className="mt-4 font-mono text-[0.7rem] tracking-[0.14em] text-night-text/70">
        {label}
      </p>
      <p className="mt-2 font-mono text-[0.72rem] leading-relaxed text-night-muted">
        {caption}
      </p>
    </div>
  );
}
