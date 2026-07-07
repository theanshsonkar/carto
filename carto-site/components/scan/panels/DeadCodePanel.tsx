import { Panel } from "@/components/ui/Panel";
import type { DeadEntry } from "../report-data";

/**
 * Dead code panel — files with high confidence of being unused. Confidence
 * bar is signal-red because "we're pretty sure this can be deleted" is a
 * dangerous action to be confident about.
 */
export function DeadCodePanel({ rows }: { rows: DeadEntry[] }) {
  const totalLines = rows.reduce((sum, r) => sum + r.lines, 0);

  return (
    <Panel
      label="DEAD CODE"
      hint={`~${totalLines.toLocaleString()} lines · confidence-scored`}
    >
      <ul className="divide-y divide-line">
        {rows.map((r, i) => (
          <li
            key={i}
            className="flex items-baseline gap-4 py-3 first:pt-0 last:pb-0"
          >
            <span className="w-14 shrink-0 border border-signal px-1.5 py-0.5 text-center font-mono text-[0.68rem] text-signal">
              {Math.round(r.confidence * 100)}%
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[0.82rem] text-ink">
                {r.path}
              </p>
              <p className="mt-1 font-mono text-[0.7rem] text-ink-3">
                {r.reason}
              </p>
            </div>
            <span className="hidden font-mono text-[0.72rem] text-ink-2 md:inline">
              {r.lines.toLocaleString()} lines
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
