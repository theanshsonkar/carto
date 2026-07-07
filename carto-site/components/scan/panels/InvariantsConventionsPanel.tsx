import { Panel } from "@/components/ui/Panel";
import type { Invariant, Convention } from "../report-data";

/**
 * The "brain" — Carto mines invariants and conventions out of the import
 * graph and git history without anybody writing them by hand. Two stacked
 * lists inside a single panel. Invariants get an adherence percentage; safe
 * green when >= 95%, ink otherwise. Conventions include a mono example.
 */
export function InvariantsConventionsPanel({
  invariants,
  conventions,
}: {
  invariants: Invariant[];
  conventions: Convention[];
}) {
  return (
    <Panel
      label="INVARIANTS & CONVENTIONS"
      hint="mined from the graph · nobody wrote these"
    >
      <div>
        <p className="mb-3 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-3">
          invariants
        </p>
        <ul className="space-y-2.5">
          {invariants.map((inv, i) => (
            <li key={i} className="flex items-baseline gap-3">
              <span
                className={`w-14 shrink-0 border px-1.5 py-0.5 text-center font-mono text-[0.68rem] ${
                  inv.adherence >= 0.95
                    ? "border-safe text-safe"
                    : inv.adherence >= 0.85
                      ? "border-line text-ink-2"
                      : "border-signal text-signal"
                }`}
              >
                {Math.round(inv.adherence * 100)}%
              </span>
              <span className="min-w-0 flex-1 text-[0.85rem] text-ink">
                {inv.text}
              </span>
              <span className="hidden font-mono text-[0.68rem] text-ink-3 sm:inline">
                {inv.scope}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <p className="mb-3 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-3">
          conventions
        </p>
        <ul className="space-y-4">
          {conventions.map((c, i) => (
            <li key={i}>
              <p className="text-[0.88rem] leading-relaxed text-ink">
                {c.text}
              </p>
              <pre className="mt-2 overflow-x-auto border border-line bg-paper px-3 py-2 font-mono text-[0.72rem] leading-relaxed text-route">
                {c.example}
              </pre>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
