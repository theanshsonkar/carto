import { Panel } from "@/components/ui/Panel";
import type { Decision } from "../report-data";

/**
 * Decision log — Carto's episodic memory made visible. Each entry is a
 * question that came up in a chat, the verdict Carto recorded, when it
 * happened, and how many files it applies to. The "did_we_discuss_this()"
 * pitch in list form.
 */
export function DecisionLogPanel({ decisions }: { decisions: Decision[] }) {
  return (
    <Panel
      label="DECISION LOG"
      hint="episodic memory · did_we_discuss_this()"
    >
      <ol className="space-y-4">
        {decisions.map((d, i) => (
          <li
            key={i}
            className="border-l-2 border-route bg-paper py-2 pl-4 pr-2"
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 flex-1 text-[0.88rem] font-medium leading-snug text-ink">
                {d.q}
              </p>
              <span className="font-mono text-[0.68rem] text-ink-3">
                {d.when}
              </span>
            </div>
            <p className="mt-2 flex items-baseline gap-2">
              <span className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-route">
                verdict
              </span>
              <span className="text-[0.85rem] leading-relaxed text-ink-2">
                {d.verdict}
              </span>
            </p>
            <p className="mt-2 font-mono text-[0.68rem] text-ink-3">
              applies to {d.files} file{d.files === 1 ? "" : "s"}
            </p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
