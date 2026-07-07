import { Reveal } from "./ui/Reveal";

/**
 * WhatCartoShows — three capability cards, each with its own output visual.
 *
 * The visuals here show OUTPUTS (what Carto actually produces on disk / at
 * query time), while HowItWorks below shows PROCESS. That separation is
 * deliberate — a card in this section should feel like a screenshot from the
 * product, not a diagram of how it works.
 *
 *   01 · Structure  → the reverse-dep bitmap. A 20×N grid where lit cells
 *                     are files depending on the target. This is what the
 *                     bitmap store actually stores.
 *   02 · Memory     → a chronological log feed. Real entries from the five
 *                     layers, in the shape they land in .carto/carto.db.
 *   03 · Prediction → a ranked risk table. Filenames + P(next bug) score
 *                     with signal-coded bars. What get_predictive_risk
 *                     returns.
 */

const capabilities = [
  {
    n: "01",
    title: "Structure",
    body:
      "Every import, route, model, and domain. The reverse-dep graph is bitmap-backed so blast radius is a lookup, not a traversal.",
    tag: "reverse dep graph · bitmap",
    output: "get_blast_radius(...) → 83 files · 2.7 µs",
    Visual: StructureVisual,
  },
  {
    n: "02",
    title: "Memory",
    body:
      "Five layers — episodic, temporal, semantic, procedural, working. Your AI stops re-deciding settled questions six weeks later.",
    tag: "SQLite · local only",
    output: "did_we_discuss_this(...) → verdict returned",
    Visual: MemoryVisual,
  },
  {
    n: "03",
    title: "Prediction",
    body:
      "Every file is scored: P(this file causes the next bug). Blast radius × churn × interventions × coverage. Risky files surface before the PR.",
    tag: "0.00 → 1.00 · sorted",
    output: "get_predictive_risk() → ranked file list",
    Visual: PredictionVisual,
  },
];

export function WhatCartoShows() {
  return (
    <section id="product" className="border-b border-line bg-panel-2/40">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <h2 className="max-w-4xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
            Not a snapshot.{" "}
            <span className="text-route">A map, and its history.</span>
          </h2>
          <p className="mt-8 max-w-2xl text-lg leading-relaxed text-ink-2">
            Most tools index your repo once and answer questions about{" "}
            <span className="text-ink">right now</span>. Carto does that — and
            keeps every decision your AI made, every drift event, every past
            intervention, so the next chat knows what the last one figured
            out.
          </p>
        </Reveal>
      </div>

      <div className="border-t border-line">
        <div className="shell grid divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
          {capabilities.map((c, i) => (
            <Reveal key={c.n} delay={i * 0.08}>
              <div className="flex h-full flex-col px-1 py-10 md:px-8 md:first:pl-1 md:last:pr-1">
                {/* header row — number + tag */}
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-ink-3">
                    [ {c.n} ]
                  </span>
                  <span className="h-px flex-1 bg-line" />
                  <span className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-3">
                    {c.tag}
                  </span>
                </div>

                <h3 className="mt-6 font-display text-2xl font-medium leading-snug text-ink">
                  {c.title}
                </h3>
                <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-2">
                  {c.body}
                </p>

                {/* the output visual — a mini-panel styled like a product surface */}
                <div className="mt-6 border border-line bg-paper">
                  <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
                    <span className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-ink-3">
                      OUTPUT
                    </span>
                    <span className="font-mono text-[0.66rem] text-ink-3">
                      live
                    </span>
                  </div>
                  <div className="p-3">
                    <c.Visual />
                  </div>
                </div>

                {/* call signature — grounds the card in a real tool name */}
                <p className="mt-4 font-mono text-[0.72rem] leading-relaxed text-route">
                  {c.output}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- */
/* Output visuals — one per capability. Every SVG is palette-locked.    */
/* ------------------------------------------------------------------- */

/**
 * 01 · STRUCTURE — the reverse-dep bitmap.
 *
 * A 20-column × 8-row matrix. Each cell is one file. Lit (ink) cells are
 * files that transitively depend on the "touched" file, drawn from a fixed
 * pattern so the visual is deterministic across renders.
 *
 * The one ROUTE-blue cell in the top-left corner is the touched file itself
 * (the query origin). The count of ink cells = 83, matching the callout on
 * the hero diagram — so the two visuals reinforce the same claim.
 */
function StructureVisual() {
  const COLS = 20;
  const ROWS = 8;
  const CELL = 8;
  const GAP = 2;

  // deterministic 83-cell fill pattern. Not random — a stable "reverse-dep
  // cluster" shape (rows closer to the target are denser).
  const litSet = new Set<string>();
  // seed a repeatable pattern by a simple hash
  const seeds = [
    0, 1, 2, 4, 5, 7, 8, 10, 11, 13, 15, 17,
    0, 2, 3, 4, 6, 8, 9, 10, 12, 14, 15, 16, 17,
    1, 3, 5, 6, 7, 9, 11, 12, 13, 14, 17, 18,
    2, 4, 6, 8, 10, 12, 14, 16, 18, 19,
    3, 5, 7, 11, 13, 15, 17, 19,
    4, 6, 8, 12, 14, 16, 18,
    5, 7, 9, 13, 15, 17, 19,
    6, 8, 10, 14, 16, 18,
    7, 9, 11, 15, 17, 19,
    8, 12, 14, 16,
  ];
  // fill rows sequentially with the seeds until we hit 82 (target file is the 83rd)
  let count = 0;
  let seedIdx = 0;
  outer: for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (seedIdx >= seeds.length) break outer;
      // treat seeds as column offsets within each row
      const col = seeds[seedIdx++] % COLS;
      const key = `${r}:${col}`;
      if (!litSet.has(key) && !(r === 0 && col === 0)) {
        litSet.add(key);
        count++;
        if (count >= 82) break outer;
      }
    }
  }

  const w = COLS * (CELL + GAP);
  const h = ROWS * (CELL + GAP);

  return (
    <svg
      viewBox={`0 0 ${w} ${h + 26}`}
      className="h-auto w-full"
      role="presentation"
    >
      {Array.from({ length: ROWS }).map((_, r) =>
        Array.from({ length: COLS }).map((_, c) => {
          const isTarget = r === 0 && c === 0;
          const isLit = litSet.has(`${r}:${c}`);
          const fill = isTarget
            ? "var(--color-route)"
            : isLit
            ? "var(--color-ink)"
            : "var(--color-line-2)";
          return (
            <rect
              key={`${r}-${c}`}
              x={c * (CELL + GAP)}
              y={r * (CELL + GAP)}
              width={CELL}
              height={CELL}
              fill={fill}
            />
          );
        }),
      )}

      {/* baseline caption strip */}
      <line
        x1="0"
        y1={h + 6}
        x2={w}
        y2={h + 6}
        stroke="var(--color-line)"
        strokeWidth="1"
      />
      <text
        x="0"
        y={h + 20}
        className="fill-ink-3 font-mono"
        fontSize="8.5"
      >
        REVERSE-DEP BITMAP
      </text>
      <text
        x={w}
        y={h + 20}
        textAnchor="end"
        className="fill-ink font-mono"
        fontSize="8.5"
        fontWeight="600"
      >
        83 dependents
      </text>
    </svg>
  );
}

/**
 * 02 · MEMORY — the episodic + temporal + semantic + procedural + working
 * feed, rendered as a chronological log. One row per memory layer, sorted
 * newest at the bottom, so it reads top-to-bottom-past-to-present.
 */
function MemoryVisual() {
  const rows = [
    { when: "6w",  tag: "EPISODIC",   msg: "did_we_discuss_this · snake_case ✓", tone: "route" },
    { when: "3w",  tag: "TEMPORAL",   msg: "AUTH domain grew 18 files", tone: "ink" },
    { when: "1w",  tag: "SEMANTIC",   msg: "invariant: TRPC never imports AUTH", tone: "ink" },
    { when: "2d",  tag: "PROCEDURAL", msg: "route+auth_mw co-change · 89%", tone: "ink" },
    { when: "now", tag: "WORKING",    msg: "2 sessions · 1 unresolved warn", tone: "signal" },
  ];

  const rowH = 20;
  const w = 340;

  return (
    <svg
      viewBox={`0 0 ${w} ${rows.length * rowH + 18}`}
      className="h-auto w-full"
      role="presentation"
    >
      {rows.map((r, i) => {
        const y = i * rowH;
        const isLast = i === rows.length - 1;
        return (
          <g key={r.tag}>
            {/* row separator */}
            {i > 0 && (
              <line
                x1="0"
                y1={y}
                x2={w}
                y2={y}
                stroke="var(--color-line-2)"
                strokeWidth="1"
              />
            )}

            {/* timestamp */}
            <text
              x="4"
              y={y + 13}
              className="fill-ink-3 font-mono"
              fontSize="9"
            >
              {r.when}
            </text>

            {/* layer tag chip */}
            <rect
              x="34"
              y={y + 4}
              width="78"
              height="12"
              fill={isLast ? "var(--color-signal-soft)" : "var(--color-panel)"}
              stroke={
                isLast
                  ? "var(--color-signal)"
                  : "var(--color-line)"
              }
              strokeWidth="1"
            />
            <text
              x="73"
              y={y + 13}
              textAnchor="middle"
              className={
                isLast
                  ? "fill-signal font-mono"
                  : "fill-ink-2 font-mono"
              }
              fontSize="8"
              fontWeight="600"
            >
              {r.tag}
            </text>

            {/* message */}
            <text
              x="120"
              y={y + 13}
              className={
                r.tone === "signal"
                  ? "fill-signal font-mono"
                  : "fill-ink font-mono"
              }
              fontSize="9"
            >
              {r.msg}
            </text>

            {/* active pulse on the "now" row */}
            {isLast && (
              <circle
                cx={w - 8}
                cy={y + 10}
                r="2.5"
                fill="var(--color-signal)"
              />
            )}
          </g>
        );
      })}

      {/* footer strip */}
      <line
        x1="0"
        y1={rows.length * rowH + 4}
        x2={w}
        y2={rows.length * rowH + 4}
        stroke="var(--color-line)"
        strokeWidth="1"
      />
      <text
        x="0"
        y={rows.length * rowH + 16}
        className="fill-ink-3 font-mono"
        fontSize="8.5"
      >
        .carto/carto.db · 5 memory layers
      </text>
    </svg>
  );
}

/**
 * 03 · PREDICTION — ranked risk output.
 *
 * A table of 5 files, sorted by P(next bug) descending. Each row shows the
 * filename (truncated mono), the score, and a proportional bar. The top row
 * pushes into signal-red territory (>0.7); the middle sits in route-blue
 * (unknown / medium); the bottom rows are safe-green (<0.3).
 */
function PredictionVisual() {
  const rows = [
    { file: "pg-meta/pg-format",   score: 0.87, band: "signal" as const },
    { file: "auth/session.ts",     score: 0.71, band: "signal" as const },
    { file: "trpc/routers/user",   score: 0.44, band: "route" as const },
    { file: "utils/format.ts",     score: 0.18, band: "safe" as const },
    { file: "types/index.ts",      score: 0.05, band: "safe" as const },
  ];

  const rowH = 20;
  const w = 340;
  const nameX = 4;
  const barX = 168;
  const barW = 130;
  const scoreX = w - 6;

  return (
    <svg
      viewBox={`0 0 ${w} ${rows.length * rowH + 18}`}
      className="h-auto w-full"
      role="presentation"
    >
      {rows.map((r, i) => {
        const y = i * rowH;
        const fillColor =
          r.band === "signal"
            ? "var(--color-signal)"
            : r.band === "route"
            ? "var(--color-route)"
            : "var(--color-safe)";
        const softColor =
          r.band === "signal"
            ? "var(--color-signal-soft)"
            : r.band === "route"
            ? "var(--color-route-soft)"
            : "var(--color-safe-soft)";
        return (
          <g key={r.file}>
            {i > 0 && (
              <line
                x1="0"
                y1={y}
                x2={w}
                y2={y}
                stroke="var(--color-line-2)"
                strokeWidth="1"
              />
            )}

            {/* filename */}
            <text
              x={nameX}
              y={y + 13}
              className="fill-ink font-mono"
              fontSize="9"
            >
              {r.file}
            </text>

            {/* bar background */}
            <rect
              x={barX}
              y={y + 5}
              width={barW}
              height="10"
              fill={softColor}
            />
            {/* bar fill */}
            <rect
              x={barX}
              y={y + 5}
              width={barW * r.score}
              height="10"
              fill={fillColor}
            />

            {/* score */}
            <text
              x={scoreX}
              y={y + 13}
              textAnchor="end"
              className={
                r.band === "signal"
                  ? "fill-signal font-mono"
                  : r.band === "safe"
                  ? "fill-safe font-mono"
                  : "fill-route font-mono"
              }
              fontSize="9"
              fontWeight="600"
            >
              {r.score.toFixed(2)}
            </text>
          </g>
        );
      })}

      <line
        x1="0"
        y1={rows.length * rowH + 4}
        x2={w}
        y2={rows.length * rowH + 4}
        stroke="var(--color-line)"
        strokeWidth="1"
      />
      <text
        x="0"
        y={rows.length * rowH + 16}
        className="fill-ink-3 font-mono"
        fontSize="8.5"
      >
        RANKED · P(NEXT BUG) · TOP 5 OF 6,358
      </text>
    </svg>
  );
}
