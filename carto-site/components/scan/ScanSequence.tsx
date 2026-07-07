"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";

type Step = {
  label: string;
  detail: string;
  ms: number;
};

const steps: Step[] = [
  { label: "clone", detail: "shallow clone via git-http", ms: 900 },
  { label: "parse", detail: "AST + regex fallback · 14 languages", ms: 1200 },
  {
    label: "graph",
    detail: "build import graph · resolve tsconfig aliases",
    ms: 1000,
  },
  { label: "routes", detail: "extract routes · Express · Next · FastAPI", ms: 700 },
  { label: "models", detail: "detect Prisma · Zod · TS interfaces", ms: 700 },
  { label: "domains", detail: "cluster files into domains", ms: 800 },
  { label: "bitmap", detail: "compile reverse-dep bitmap", ms: 900 },
  { label: "risk", detail: "score P(next bug) per file", ms: 1000 },
  { label: "invariants", detail: "mine conventions from graph", ms: 700 },
  { label: "signals", detail: "seed episodic + temporal memory", ms: 600 },
];

/**
 * The scanning animation. Night palette, terminal-shaped panel, one step
 * highlighted at a time. Streams "sample files" scrolling underneath to make
 * the parsing feel real. Calls onComplete when all steps finish.
 */
export function ScanSequence({
  url,
  onComplete,
}: {
  url: string;
  onComplete: () => void;
}) {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (current >= steps.length) {
      const done = setTimeout(onComplete, 600);
      return () => clearTimeout(done);
    }
    const t = setTimeout(() => setCurrent((c) => c + 1), steps[current].ms);
    return () => clearTimeout(t);
  }, [current, onComplete]);

  const pctDone = Math.min(100, (current / steps.length) * 100);
  const repo = displayName(url);

  return (
    <section className="min-h-[70vh] border-b border-night-line bg-night text-night-text">
      <div className="shell py-16 md:py-24">
        <div className="mx-auto max-w-3xl">
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-night-muted">
            [ SCANNING ]
          </p>
          <h1 className="mt-3 font-display text-3xl font-medium leading-[1.1] tracking-tight md:text-5xl">
            Mapping{" "}
            <span className="font-mono text-night-route">{repo}</span>
          </h1>

          {/* the terminal */}
          <div className="mt-10 overflow-hidden border border-night-line bg-[#16140f]">
            <header className="flex items-center justify-between border-b border-night-line px-4 py-2.5">
              <span className="font-mono text-[0.72rem] text-night-muted">
                carto init {repo}
              </span>
              <span className="font-mono text-[0.72rem] text-night-muted">
                {Math.round(pctDone)}%
              </span>
            </header>

            <div className="relative h-1 w-full bg-night-line">
              <motion.div
                className="absolute inset-y-0 left-0 bg-night-route"
                animate={{ width: `${pctDone}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />
            </div>

            <div className="min-h-[380px] px-4 py-4 font-mono text-[0.82rem] leading-relaxed">
              {steps.slice(0, current + 1).map((s, i) => {
                const done = i < current;
                const active = i === current && current < steps.length;
                return (
                  <div key={s.label} className="flex items-baseline gap-3">
                    <span
                      className={
                        done
                          ? "text-night-safe"
                          : active
                            ? "text-night-route"
                            : "text-night-muted"
                      }
                    >
                      {done ? "✓" : active ? "›" : "○"}
                    </span>
                    <span
                      className={
                        done ? "text-night-text" : "text-night-text"
                      }
                    >
                      {s.label}
                    </span>
                    <span className="text-night-muted">·</span>
                    <span className="text-night-muted">{s.detail}</span>
                    {active && <BlinkCursor />}
                    {done && (
                      <span className="ml-auto text-night-muted">
                        {(s.ms / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* fake file stream at the bottom */}
            <footer className="border-t border-night-line bg-[#12100c] px-4 py-3">
              <StreamingFiles active={current < steps.length} />
            </footer>
          </div>

          <p className="mt-6 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-night-muted">
            One SQLite file · no network · no telemetry
          </p>
        </div>
      </div>
    </section>
  );
}

function BlinkCursor() {
  return (
    <motion.span
      aria-hidden
      className="inline-block h-[0.9em] w-[6px] translate-y-[1px] bg-night-route"
      animate={{ opacity: [1, 0, 1] }}
      transition={{ duration: 0.9, repeat: Infinity }}
    />
  );
}

/**
 * Scrolls a rotating list of fake file paths to sell "parsing in progress."
 * All client-side, capped, no real work.
 */
const files = [
  "src/auth/session.ts",
  "packages/api/routes/users.ts",
  "lib/db/client.ts",
  "components/Editor/Toolbar.tsx",
  "server/middleware/rate-limit.ts",
  "src/utils/jwt.ts",
  "packages/pg-meta/src/pg-format/index.ts",
  "app/(dashboard)/settings/page.tsx",
  "src/hooks/useMonaco.ts",
  "modules/billing/checkout.ts",
  "packages/ui/src/Dialog.tsx",
  "internal/telemetry/otlp.ts",
];

function StreamingFiles({ active }: { active: boolean }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((n) => (n + 1) % files.length), 220);
    return () => clearInterval(t);
  }, [active]);

  const visible = [
    files[i % files.length],
    files[(i + 1) % files.length],
    files[(i + 2) % files.length],
  ];

  return (
    <div className="grid grid-cols-3 gap-4 overflow-hidden font-mono text-[0.72rem]">
      {visible.map((f, idx) => (
        <div
          key={`${f}-${i}-${idx}`}
          className="truncate text-night-muted"
        >
          <span className="text-night-safe">✓</span>{" "}
          <span className="text-night-text">{f}</span>
        </div>
      ))}
    </div>
  );
}

function displayName(url: string): string {
  const clean = url
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return clean || "your-repo";
}
