import { Reveal } from "./ui/Reveal";

/**
 * Positioning — the "why should I trust this" block. Carto has no paid tier,
 * so this is not a pricing card; it's a positioning statement. Three columns
 * of what Carto ISN'T (no cloud, no telemetry, no paywall) alongside the
 * bold headline claim. Sits where a SaaS site would put pricing — the
 * developer buyer looks for it in this position, and its absence would read
 * as evasion. So we occupy the position and turn the answer into the moat.
 */

const commitments = [
  {
    tag: "01 · LICENSE",
    title: "MIT.",
    body:
      "Free forever. Use it in commercial products, fork it, self-host it, run it in air-gapped labs. Nothing to negotiate.",
  },
  {
    tag: "02 · NETWORK",
    title: "Local only.",
    body:
      "One SQLite file on your disk. No cloud, no phone-home, no telemetry. Your code never leaves your machine — verifiable by running `lsof`.",
  },
  {
    tag: "03 · SURFACE",
    title: "Open format.",
    body:
      "Every artifact Carto builds — ANCI graph, decision log, invariants — is a documented file on disk. Any tool can read them. No lock-in.",
  },
];

export function Positioning() {
  return (
    <section id="positioning" className="border-b border-line bg-panel-2/40">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ink-3">
            [ WHAT IT COSTS · WHAT IT KEEPS ]
          </p>
          <h2 className="mt-6 max-w-4xl font-display text-4xl font-medium leading-[1.02] tracking-tight text-ink md:text-6xl">
            No pricing page.{" "}
            <span className="text-route">Because there&apos;s no price.</span>
          </h2>
          <p className="mt-6 max-w-2xl text-[1rem] leading-relaxed text-ink-2">
            Carto is MIT, local, and one file on disk. It is not a hosted
            service. It is not a SaaS. It is not going to change its mind
            about that in eighteen months.
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="mt-14 grid gap-px border border-line bg-line md:grid-cols-3">
            {commitments.map((c) => (
              <div
                key={c.tag}
                className="flex flex-col gap-5 bg-paper p-8"
              >
                <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
                  {c.tag}
                </span>
                <h3 className="font-display text-3xl font-medium leading-none tracking-tight text-ink">
                  {c.title}
                </h3>
                <p className="mt-1 text-[0.95rem] leading-relaxed text-ink-2">
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </Reveal>

        {/* the receipt strip — pinned metrics that back the claims above */}
        <Reveal delay={0.14}>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border border-line bg-paper px-6 py-4">
            <Chip label="LICENSE" value="MIT" />
            <Chip label="COST" value="$0 · forever" />
            <Chip label="STORAGE" value="One .db file" />
            <Chip label="NETWORK CALLS" value="0" tone="route" />
            <Chip label="TELEMETRY" value="Never" tone="route" />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Chip({
  label,
  value,
  tone = "ink",
}: {
  label: string;
  value: string;
  tone?: "ink" | "route";
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-3">
        {label}
      </span>
      <span
        className={`font-mono text-[0.9rem] ${
          tone === "route" ? "text-route" : "text-ink"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
