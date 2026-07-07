import { Panel } from "@/components/ui/Panel";
import type { HighImpactFile } from "../report-data";

/**
 * The top-N files by transitive dependents. Sorted desc. Deps count is red
 * for anything past the danger line (60), route-blue for medium, ink for low.
 * A tiny horizontal bar next to each row gives at-a-glance scale.
 */
export function HighImpactTable({ rows }: { rows: HighImpactFile[] }) {
  const max = Math.max(...rows.map((r) => r.deps), 1);

  return (
    <Panel label="HIGH-IMPACT FILES" hint={`top ${rows.length} by transitive deps`}>
      <div className="overflow-x-auto">
        <table className="w-full text-[0.85rem]">
          <thead>
            <tr className="border-b border-line font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-3">
              <th className="w-8 pb-3 pr-2 text-right">#</th>
              <th className="pb-3 text-left">File</th>
              <th className="pb-3 pl-4 text-left">Domain</th>
              <th className="pb-3 pl-4 text-right">Deps</th>
              <th className="w-40 pb-3 pl-4"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const tone =
                r.deps >= 60
                  ? "text-signal"
                  : r.deps >= 30
                    ? "text-route"
                    : "text-ink";
              const barTone =
                r.deps >= 60 ? "bg-signal" : r.deps >= 30 ? "bg-route" : "bg-ink";
              return (
                <tr
                  key={r.path}
                  className={i < rows.length - 1 ? "border-b border-line/50" : ""}
                >
                  <td className="py-2.5 pr-2 text-right font-mono text-[0.7rem] text-ink-3">
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td className="py-2.5 font-mono text-ink">{r.path}</td>
                  <td className="py-2.5 pl-4">
                    <span className="border border-line bg-paper px-1.5 py-0.5 font-mono text-[0.7rem] text-ink-2">
                      {r.domain}
                    </span>
                  </td>
                  <td className={`py-2.5 pl-4 text-right font-mono font-semibold ${tone}`}>
                    {r.deps}
                  </td>
                  <td className="py-2.5 pl-4">
                    <span className="relative block h-1 w-full bg-line-2">
                      <span
                        className={`absolute inset-y-0 left-0 ${barTone}`}
                        style={{ width: `${(r.deps / max) * 100}%` }}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
