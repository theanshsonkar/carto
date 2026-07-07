import { Panel } from "@/components/ui/Panel";
import type { Report } from "../report-data";

/**
 * The top-line risk verdict. One big number (0-100), a mono label ("watch a
 * few"), and five category bars. Weak categories get a signal-red bar; the
 * rest are ink. Mirrors cofounder's TheScore panel exactly.
 */
export function RiskScoreCard({ risk }: { risk: Report["risk"] }) {
  return (
    <Panel label="RISK SCORE" hint="P(next bug) rolled up">
      <div className="flex items-start justify-between border-b border-line pb-5">
        <div>
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
            overall
          </p>
          <p className="mt-2 font-display text-6xl font-semibold leading-none text-ink">
            {risk.overall}
            <span className="ml-1 text-2xl text-ink-3">/ 100</span>
          </p>
        </div>
        <span
          className={`border px-2.5 py-1 font-mono text-[0.7rem] uppercase tracking-[0.1em] ${
            risk.overall >= 75
              ? "border-safe text-safe"
              : risk.overall >= 60
                ? "border-line text-ink-2"
                : "border-signal text-signal"
          }`}
        >
          ● {risk.label}
        </span>
      </div>

      <ul className="mt-5 space-y-3.5">
        {risk.categories.map((c) => (
          <li key={c.label}>
            <div className="flex items-center gap-4">
              <span className="w-32 shrink-0 font-mono text-[0.78rem] text-ink-2">
                {c.label}
              </span>
              <span className="relative h-1.5 flex-1 bg-line-2">
                <span
                  className={`absolute inset-y-0 left-0 ${c.weak ? "bg-signal" : "bg-ink"}`}
                  style={{ width: `${c.score}%` }}
                />
              </span>
              <span
                className={`w-7 text-right font-mono text-[0.78rem] ${c.weak ? "text-signal" : "text-ink"}`}
              >
                {c.score}
              </span>
            </div>
            <p className="ml-32 mt-1 font-mono text-[0.7rem] text-ink-3">
              {c.note}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
