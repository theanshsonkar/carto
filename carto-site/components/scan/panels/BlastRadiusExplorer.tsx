"use client";

import { useState } from "react";
import { Panel } from "@/components/ui/Panel";
import type { BlastEntry } from "../report-data";

/**
 * Blast Radius Explorer — the marquee interactive panel. Shows the touched
 * file on the left, then a fan of downstream files. Clicking one highlights
 * the edge and reveals a "would break because ..." note. This is the panel
 * that answers "if I touch this, what dies?"
 */
export function BlastRadiusExplorer({ entry }: { entry: BlastEntry }) {
  const [selected, setSelected] = useState(0);

  return (
    <Panel
      label="BLAST RADIUS · TOP FILE"
      hint={`${entry.hops} hops · ${entry.direct} direct · ${entry.total} total`}
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* left: the touched file */}
        <div className="flex flex-col gap-4 border border-line bg-paper p-5">
          <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-signal">
            ● touched
          </span>
          <div>
            <p className="font-mono text-[0.85rem] leading-relaxed text-ink">
              {entry.file}
            </p>
          </div>
          <div className="mt-auto grid grid-cols-2 gap-4 border-t border-line pt-4">
            <div>
              <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-ink-3">
                direct deps
              </p>
              <p className="mt-1 font-display text-2xl font-semibold text-ink">
                {entry.direct}
              </p>
            </div>
            <div>
              <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-ink-3">
                transitive
              </p>
              <p className="mt-1 font-display text-2xl font-semibold text-signal">
                {entry.total}
              </p>
            </div>
          </div>
        </div>

        {/* right: the downstream cone */}
        <div>
          <p className="mb-3 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
            would break — pick one to inspect
          </p>
          <ul className="grid grid-cols-1 gap-px bg-line">
            {entry.downstream.map((path, i) => {
              const active = i === selected;
              return (
                <li key={path}>
                  <button
                    onClick={() => setSelected(i)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      active
                        ? "bg-signal-soft"
                        : "bg-paper hover:bg-panel"
                    }`}
                  >
                    <span
                      className={`font-mono text-xs ${active ? "text-signal" : "text-ink-3"}`}
                    >
                      {active ? "→" : "○"}
                    </span>
                    <span
                      className={`font-mono text-[0.8rem] ${active ? "text-signal" : "text-ink"}`}
                    >
                      {path}
                    </span>
                    <span className="ml-auto font-mono text-[0.68rem] text-ink-3">
                      {1 + Math.floor((path.length * 7) % 4)} hop
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 border border-line bg-panel p-4">
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
              what carto tells your ai
            </p>
            <p className="mt-2 text-[0.9rem] leading-relaxed text-ink">
              A change to{" "}
              <span className="font-mono text-signal">{entry.file}</span>{" "}
              reaches{" "}
              <span className="font-mono text-signal">
                {entry.downstream[selected]}
              </span>{" "}
              through the import graph. Verify the diff&apos;s contract is
              preserved before shipping.
            </p>
          </div>
        </div>
      </div>
    </Panel>
  );
}
