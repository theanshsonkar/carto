import { Panel } from "@/components/ui/Panel";
import type { Domain } from "../report-data";

/**
 * Domains grid: each domain gets a bordered card with file count, coupling
 * bar, and a stability dot (safe green = stable, ink = drifting, red =
 * churning). Sorted by file count desc.
 */
export function DomainsGrid({ domains }: { domains: Domain[] }) {
  const sorted = [...domains].sort((a, b) => b.files - a.files);
  const maxFiles = Math.max(...sorted.map((d) => d.files), 1);

  return (
    <Panel label="DOMAINS" hint={`${sorted.length} clustered from imports`}>
      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
        {sorted.map((d) => (
          <div key={d.name} className="flex flex-col gap-3 bg-panel p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[0.85rem] font-medium text-ink">
                {d.name}
              </span>
              <StabilityBadge kind={d.stability} />
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className="font-display text-2xl font-semibold leading-none text-ink">
                  {d.files.toLocaleString()}
                </span>
                <span className="font-mono text-[0.7rem] text-ink-3">files</span>
              </div>
              <div className="mt-2 h-1 w-full bg-line-2">
                <div
                  className="h-full bg-ink"
                  style={{ width: `${(d.files / maxFiles) * 100}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
                  coupling
                </span>
                <span className="font-mono text-[0.72rem] text-ink">
                  {(d.coupling * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-1.5 h-1 w-full bg-line-2">
                <div
                  className={d.coupling >= 0.6 ? "h-full bg-signal" : "h-full bg-route"}
                  style={{ width: `${d.coupling * 100}%` }}
                />
              </div>
            </div>

            <p className="font-mono text-[0.7rem] text-ink-3">{d.note}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function StabilityBadge({ kind }: { kind: Domain["stability"] }) {
  const styles = {
    stable: "border-safe text-safe",
    drifting: "border-line text-ink-2",
    churning: "border-signal text-signal",
  } as const;
  return (
    <span
      className={`border px-1.5 py-0.5 font-mono text-[0.62rem] uppercase tracking-[0.12em] ${styles[kind]}`}
    >
      ● {kind}
    </span>
  );
}
