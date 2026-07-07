import { Panel } from "@/components/ui/Panel";
import type { CrossDomainViolation } from "../report-data";

/**
 * Cross-domain violations panel. Each entry shows a from→to arrow where the
 * two domains are on either side of the arrow, both files spelled out under
 * them, and a short reason. Kind is tagged in the top row.
 */
export function CrossDomainPanel({
  violations,
}: {
  violations: CrossDomainViolation[];
}) {
  if (violations.length === 0) {
    return (
      <Panel label="CROSS-DOMAIN" hint="no layering violations">
        <p className="font-mono text-[0.85rem] text-safe">
          ● all imports respect domain boundaries.
        </p>
      </Panel>
    );
  }

  return (
    <Panel label="CROSS-DOMAIN VIOLATIONS" hint={`${violations.length} found`}>
      <ul className="space-y-4">
        {violations.map((v, i) => (
          <li
            key={i}
            className="border border-line bg-paper p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-signal">
                {v.kind}
              </span>
              <span className="font-mono text-[0.7rem] text-ink-3">
                boundary broken
              </span>
            </div>

            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div>
                <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-ink-3">
                  from · {v.fromDomain}
                </p>
                <p className="mt-1 font-mono text-[0.78rem] text-ink">
                  {v.from}
                </p>
              </div>

              <span
                aria-hidden
                className="font-mono text-lg text-signal"
              >
                →
              </span>

              <div>
                <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-ink-3">
                  to · {v.toDomain}
                </p>
                <p className="mt-1 font-mono text-[0.78rem] text-ink">
                  {v.to}
                </p>
              </div>
            </div>

            <p className="mt-3 border-t border-line pt-3 font-mono text-[0.72rem] text-ink-2">
              {v.note}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
