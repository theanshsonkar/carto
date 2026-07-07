import { Reveal } from "./ui/Reveal";

type Cell = "yes" | "no" | "partial";

type Row = {
  label: string;
  carto: Cell;
  sourcegraph: Cell;
  continueIde: Cell;
  cursor: Cell;
};

const rows: Row[] = [
  { label: "Sub-millisecond blast radius", carto: "yes", sourcegraph: "no", continueIde: "no", cursor: "no" },
  { label: "Reverse-dep graph (bitmap)", carto: "yes", sourcegraph: "partial", continueIde: "no", cursor: "no" },
  { label: "Cross-session memory (decisions, drift)", carto: "yes", sourcegraph: "no", continueIde: "partial", cursor: "no" },
  { label: "Works in every AI tool", carto: "yes", sourcegraph: "no", continueIde: "no", cursor: "no" },
  { label: "Local-only · no cloud", carto: "yes", sourcegraph: "no", continueIde: "yes", cursor: "partial" },
  { label: "MIT · free forever", carto: "yes", sourcegraph: "no", continueIde: "yes", cursor: "no" },
  { label: "One SQLite file · portable", carto: "yes", sourcegraph: "no", continueIde: "no", cursor: "no" },
  { label: "Open format (ANCI)", carto: "yes", sourcegraph: "no", continueIde: "no", cursor: "no" },
  { label: "Routes + models + domain extraction", carto: "yes", sourcegraph: "partial", continueIde: "no", cursor: "partial" },
];

/**
 * Head-to-head feature table against named competitors. Aggressive but honest
 * — every cell reflects the actual state of things. Puts Carto in a category
 * rather than a vacuum.
 */
export function CompareTable() {
  return (
    <section className="border-b border-line bg-panel-2/40">
      <div className="shell py-20 md:py-24">
        <Reveal>
          <h2 className="max-w-3xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
            Not just faster.{" "}
            <span className="text-route">A different primitive.</span>
          </h2>
          <p className="mt-6 max-w-2xl text-[1rem] leading-relaxed text-ink-2">
            The competitors serve you a version of code search. Carto serves
            you a live graph — with a persistent memory of what got decided,
            what&apos;s drifting, and what breaks if you touch a file.
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="mt-12 overflow-x-auto border border-line bg-paper">
            <table className="w-full text-[0.9rem]">
              <thead>
                <tr className="border-b border-line font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-3">
                  <th className="px-5 py-4 text-left">Feature</th>
                  <th className="border-x-2 border-route bg-route px-4 py-4 text-center text-paper">
                    <span className="inline-flex flex-col items-center gap-1">
                      <span className="font-mono text-[0.62rem] tracking-[0.16em] text-paper/70">
                        [ BEST ]
                      </span>
                      <span className="font-mono text-[0.78rem] tracking-[0.14em] text-paper">
                        CARTO
                      </span>
                    </span>
                  </th>
                  <th className="border-l border-line px-4 py-4 text-center">
                    Sourcegraph
                  </th>
                  <th className="border-l border-line px-4 py-4 text-center">
                    Continue
                  </th>
                  <th className="border-l border-line px-4 py-4 text-center">
                    Cursor index
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.label}
                    className={
                      i < rows.length - 1 ? "border-b border-line/60" : ""
                    }
                  >
                    <td className="px-5 py-3 text-[0.88rem] text-ink">
                      {r.label}
                    </td>
                    <td className="border-x-2 border-route bg-route/[0.08] px-4 py-3 text-center">
                      <Mark cell={r.carto} strong />
                    </td>
                    <td className="border-l border-line px-4 py-3 text-center">
                      <Mark cell={r.sourcegraph} />
                    </td>
                    <td className="border-l border-line px-4 py-3 text-center">
                      <Mark cell={r.continueIde} />
                    </td>
                    <td className="border-l border-line px-4 py-3 text-center">
                      <Mark cell={r.cursor} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <p className="mx-auto mt-6 max-w-2xl text-center font-mono text-[0.72rem] text-ink-3">
          Fair-use comparison based on public docs · Sourcegraph Enterprise
          features noted as partial where cloud-only
        </p>
      </div>
    </section>
  );
}

function Mark({ cell, strong = false }: { cell: Cell; strong?: boolean }) {
  if (cell === "yes") {
    return (
      <span
        className={`inline-flex h-5 w-5 items-center justify-center border ${strong ? "border-route bg-route text-paper" : "border-line text-ink"} font-mono text-[0.7rem]`}
      >
        ✓
      </span>
    );
  }
  if (cell === "partial") {
    return (
      <span className="font-mono text-[0.72rem] uppercase tracking-[0.1em] text-ink-2">
        partial
      </span>
    );
  }
  return (
    <span aria-hidden className="font-mono text-[0.9rem] text-ink-3">
      —
    </span>
  );
}
