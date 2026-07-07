import { Eyebrow } from "./ui/Eyebrow";
import { Reveal } from "./ui/Reveal";

const perfRows = [
  { repo: "cal.com", files: "4,352", first: "3.9s", reindex: "805ms", db: "3.1 MB" },
  { repo: "supabase/supabase", files: "6,358", first: "5.9s", reindex: "967ms", db: "4.8 MB" },
  { repo: "vercel/next.js", files: "6,193", first: "6.9s", reindex: "978ms", db: "15.1 MB" },
  { repo: "microsoft/vscode", files: "7,567", first: "8.6s", reindex: "1.1s", db: "14.3 MB" },
];

const latencies = [
  { tool: "validate_diff", p50: "84 µs", note: "budget was 5 ms" },
  { tool: "get_blast_radius", p50: "2.7 µs", note: "10.7× faster than SQLite" },
  { tool: "get_high_impact_files", p50: "750 ns", note: "559× faster" },
  { tool: "simulate_change_impact", p50: "19.3 µs", note: "multi-file OR-aggregate" },
];

export function HowFast() {
  return (
    <section id="speed" className="border-b border-line bg-panel-2/40">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <h2 className="max-w-3xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
            <span className="text-route">Fast enough</span> to live in every diff.
          </h2>
          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-2">
            Bitmap-backed reverse dependency graph.{" "}
            <span className="text-ink">
              Sub-millisecond blast radius on a 7,000-file repo.
            </span>{" "}
            Every AI diff can be validated before it hits your screen —
            without slowing anything down.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-8 md:grid-cols-[1.15fr_1fr]">
          <Reveal>
            <div className="border border-line bg-panel">
              <header className="flex items-center justify-between border-b border-line bg-paper px-5 py-3">
                <Eyebrow>REAL REPOS · FRESH INDEX</Eyebrow>
                <span className="font-mono text-[0.7rem] text-ink-3">
                  M-series · 8 CPU · 8 GB
                </span>
              </header>
              <table className="w-full text-[0.85rem]">
                <thead>
                  <tr className="border-b border-line font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-3">
                    <th className="px-5 py-3 text-left">Repo</th>
                    <th className="px-3 py-3 text-right">Files</th>
                    <th className="px-3 py-3 text-right">First index</th>
                    <th className="px-3 py-3 text-right">Re-index</th>
                    <th className="px-5 py-3 text-right">DB</th>
                  </tr>
                </thead>
                <tbody>
                  {perfRows.map((r, i) => (
                    <tr
                      key={r.repo}
                      className={
                        i < perfRows.length - 1
                          ? "border-b border-line/60"
                          : ""
                      }
                    >
                      <td className="px-5 py-3 font-mono text-ink">
                        {r.repo}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-ink-2">
                        {r.files}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-ink">
                        {r.first}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-safe">
                        {r.reindex}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-ink-2">
                        {r.db}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="flex h-full flex-col border border-line bg-panel">
              <header className="flex items-center justify-between border-b border-line bg-paper px-5 py-3">
                <Eyebrow>QUERY LATENCY · VSCODE</Eyebrow>
                <span className="font-mono text-[0.7rem] text-ink-3">
                  7,567 files
                </span>
              </header>
              <ul className="flex-1 divide-y divide-line">
                {latencies.map((l) => (
                  <li key={l.tool} className="px-5 py-4">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-[0.85rem] text-ink">
                        {l.tool}
                      </span>
                      <span className="font-display text-lg font-semibold text-ink">
                        {l.p50}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[0.7rem] text-ink-3">
                      {l.note}
                    </p>
                  </li>
                ))}
              </ul>
              <footer className="border-t border-line bg-paper px-5 py-3 font-mono text-[0.7rem] text-ink-3">
                median speedup across 5 tools: <span className="text-ink">10.7×</span>
              </footer>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
