import { Panel } from "@/components/ui/Panel";
import type { DriftEvent } from "../report-data";

/**
 * Architectural drift timeline. Each event is a horizontal row with a colored
 * icon (growth/split/coupling/quiet), a "when" label, and a one-line body.
 * The whole panel reads like a project log — the temporal-memory pitch made
 * visible.
 */
export function DriftTimeline({ events }: { events: DriftEvent[] }) {
  return (
    <Panel label="ARCHITECTURAL DRIFT" hint="temporal memory · last 12 mo">
      <ol className="relative">
        {/* the vertical rail */}
        <span
          aria-hidden
          className="absolute left-[15px] top-2 bottom-2 w-px bg-line"
        />
        {events.map((e, i) => (
          <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
            <span
              aria-hidden
              className={`relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border ${iconStyle(e.kind)} bg-paper font-mono text-[0.9rem]`}
            >
              {iconChar(e.kind)}
            </span>
            <div className="flex-1 pt-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[0.72rem] uppercase tracking-[0.14em] text-ink-3">
                  {e.kind}
                  {e.domain ? ` · ${e.domain}` : ""}
                </span>
                <span className="font-mono text-[0.7rem] text-ink-3">
                  {e.when}
                </span>
              </div>
              <p className="mt-1 text-[0.9rem] leading-relaxed text-ink">
                {e.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function iconChar(kind: DriftEvent["kind"]): string {
  return { growth: "+", split: "⑂", coupling: "×", quiet: "○" }[kind];
}

function iconStyle(kind: DriftEvent["kind"]): string {
  return {
    growth: "border-safe text-safe",
    split: "border-route text-route",
    coupling: "border-signal text-signal",
    quiet: "border-line text-ink-3",
  }[kind];
}
