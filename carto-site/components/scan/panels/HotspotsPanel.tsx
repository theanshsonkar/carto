import { Panel } from "@/components/ui/Panel";
import type { Hotspot } from "../report-data";

/**
 * Hotspots panel: files sorted by P(next bug). Each row shows the score,
 * plus mini-bars for churn, blast, coverage. Red rows are the ones Carto
 * would flag on any PR touching them.
 */
export function HotspotsPanel({ rows }: { rows: Hotspot[] }) {
  const maxChurn = Math.max(...rows.map((r) => r.churn), 1);
  const maxBlast = Math.max(...rows.map((r) => r.blast), 1);

  return (
    <Panel
      label="HOTSPOTS"
      hint="risk = blast × churn × interventions ÷ coverage"
    >
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const tone =
            r.risk >= 0.75
              ? "text-signal"
              : r.risk >= 0.5
                ? "text-route"
                : "text-ink";
          return (
            <li key={r.path} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.8rem] text-ink">
                  {r.path}
                </span>
                <span className={`font-display text-lg font-semibold ${tone}`}>
                  {r.risk.toFixed(2)}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-4 font-mono text-[0.68rem]">
                <MiniStat
                  label="churn"
                  value={`${r.churn}`}
                  pct={(r.churn / maxChurn) * 100}
                  tone="ink"
                />
                <MiniStat
                  label="blast"
                  value={`${r.blast}`}
                  pct={(r.blast / maxBlast) * 100}
                  tone="signal"
                />
                <MiniStat
                  label="coverage"
                  value={`${Math.round(r.coverage * 100)}%`}
                  pct={r.coverage * 100}
                  tone="safe"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function MiniStat({
  label,
  value,
  pct,
  tone,
}: {
  label: string;
  value: string;
  pct: number;
  tone: "ink" | "signal" | "safe";
}) {
  const barTone = { ink: "bg-ink", signal: "bg-signal", safe: "bg-safe" }[tone];
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="uppercase tracking-[0.1em] text-ink-3">{label}</span>
        <span className="text-ink">{value}</span>
      </div>
      <span className="relative mt-1 block h-1 w-full bg-line-2">
        <span
          className={`absolute inset-y-0 left-0 ${barTone}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
    </div>
  );
}
