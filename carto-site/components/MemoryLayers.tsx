import { Reveal } from "./ui/Reveal";

/**
 * MemoryLayers — the section's title is "the map over time", so the visual
 * treatment centres on ONE master graph that plots all five memory layers
 * on a single 6-weeks-to-now time axis. This is Carto's whole thesis in one
 * picture: your codebase has a memory that spans layers AND time.
 *
 * The dense timeline carries the weight — the layer cards below drop from
 * 5 explanatory blocks down to a tight 5-item legend row that documents the
 * shape of each lane and the tool call that reads it.
 *
 * Different pattern from HowItWorks (4 step visuals) and WhatCartoShows
 * (3 output visuals) so the three "visual-forward" sections don't blur.
 */

const layers = [
  {
    n: "01",
    title: "Episodic",
    body:
      "Every diff Carto validated, every decision it made. Six weeks later, your AI recalls the prior verdict verbatim.",
    tool: "did_we_discuss_this(...)",
    dot: "route",
  },
  {
    n: "02",
    title: "Temporal",
    body:
      "Snapshots, churn, deltas. AUTH grew 18 files this quarter and lost stability when payments/billing.ts moved.",
    tool: "get_architectural_drift(...)",
    dot: "ink",
  },
  {
    n: "03",
    title: "Semantic",
    body:
      "Invariants and conventions mined from the import graph itself. Nobody writes these rules — Carto reads them.",
    tool: "get_invariants(...)",
    dot: "route",
  },
  {
    n: "04",
    title: "Procedural",
    body:
      "Patterns from git history. When a route gets added, the auth middleware is touched 89% of the time.",
    tool: "get_action_patterns(...)",
    dot: "ink",
  },
  {
    n: "05",
    title: "Working",
    body:
      "One call that returns what's open, what's drifting, what warnings are unresolved. Read at the start of every session.",
    tool: "get_working_memory(...)",
    dot: "signal",
  },
];

export function MemoryLayers() {
  return (
    <section id="memory" className="border-b border-line">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-[1.15fr_1fr] md:items-end">
            <h2 className="max-w-3xl font-display text-4xl font-medium leading-[1.04] tracking-tight text-ink md:text-6xl">
              The map <span className="text-route">remembers.</span>
            </h2>
            <p className="max-w-md text-[1rem] leading-relaxed text-ink-2 md:justify-self-end md:text-right">
              Five layers of memory, mined automatically from your code and
              your git history. Nothing to write by hand. Every chat starts
              where the last one left off.
            </p>
          </div>
        </Reveal>

        {/* THE MASTER TIMELINE — the section's hero visual */}
        <Reveal delay={0.1}>
          <div className="mt-14 border border-line bg-paper">
            {/* header bar */}
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="font-mono text-[0.72rem] uppercase tracking-[0.16em] text-ink-3">
                [ MEMORY GRAPH · 5 LAYERS · 6 WEEKS ]
              </span>
              <span className="font-mono text-[0.72rem] text-ink-3">
                last write · 2s ago
              </span>
            </div>

            {/* the graph */}
            <div className="p-4 md:p-6">
              <MemoryGraph />
            </div>

            {/* footer stats */}
            <div className="grid grid-cols-2 gap-px border-t border-line bg-line md:grid-cols-4">
              <FooterStat label="ENTRIES" value="1,247" />
              <FooterStat label="INVARIANTS HELD" value="63 · 100%" />
              <FooterStat label="PATTERNS MINED" value="34" />
              <FooterStat label="OPEN WARNINGS" value="1" tone="signal" />
            </div>
          </div>
        </Reveal>

        {/* LEGEND ROW — one compact strip per layer, matches the graph lanes */}
        <Reveal delay={0.18}>
          <div className="mt-8 grid gap-px border border-line bg-line md:grid-cols-5">
            {layers.map((l) => (
              <div key={l.n} className="flex flex-col bg-paper p-5">
                <div className="flex items-center gap-3">
                  <Dot tone={l.dot as "route" | "ink" | "signal"} />
                  <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
                    [ {l.n} ]
                  </span>
                </div>
                <h3 className="mt-3 font-display text-lg font-medium leading-snug text-ink">
                  {l.title}
                </h3>
                <p className="mt-2 flex-1 text-[0.85rem] leading-relaxed text-ink-2">
                  {l.body}
                </p>
                <p className="mt-4 border-t border-line pt-3 font-mono text-[0.7rem] text-route">
                  {l.tool}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- */
/* MemoryGraph — 5-lane timeline. Left column holds lane labels, right   */
/* area holds the plotted events. Every element is SVG, palette-locked,  */
/* deterministic (no random). No JS animation — Reveal handles the      */
/* fade-in for the whole block.                                         */
/* ------------------------------------------------------------------- */

// viewBox coords
const W = 960;
const H = 300;
const LABEL_W = 130; // width of the lane-label gutter
const PLOT_L = LABEL_W + 8; // where plotted data begins
const PLOT_R = W - 20; // where the plot ends (leaves room for NOW label)
const PLOT_W = PLOT_R - PLOT_L;

// 5 lanes evenly spaced within the plot vertical
const LANE_TOP = 34; // room for time-axis header
const LANE_BOT = H - 34; // room for time-axis footer
const LANE_H = (LANE_BOT - LANE_TOP) / 5;
const laneY = (i: number) => LANE_TOP + i * LANE_H + LANE_H / 2;

// time ticks — evenly spaced. x=0 → 6W ago, x=1 → NOW.
const ticks = [
  { t: 0.02, label: "6W AGO" },
  { t: 0.22, label: "4W" },
  { t: 0.42, label: "3W" },
  { t: 0.6, label: "2W" },
  { t: 0.78, label: "1W" },
  { t: 0.9, label: "2D" },
  { t: 1, label: "NOW" },
];
const tX = (t: number) => PLOT_L + t * PLOT_W;

const LANES = ["EPISODIC", "TEMPORAL", "SEMANTIC", "PROCEDURAL", "WORKING"];

function MemoryGraph() {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Five memory layers plotted on a six-week timeline. Working layer at the bottom is currently active."
    >
      {/* background lane rows — subtle alternating tint */}
      {LANES.map((_, i) => (
        <rect
          key={i}
          x={PLOT_L}
          y={LANE_TOP + i * LANE_H}
          width={PLOT_W}
          height={LANE_H}
          fill={i % 2 === 0 ? "var(--color-panel)" : "var(--color-paper)"}
        />
      ))}

      {/* horizontal lane separators */}
      {LANES.map((_, i) => (
        <line
          key={`sep-${i}`}
          x1={PLOT_L}
          y1={LANE_TOP + i * LANE_H}
          x2={PLOT_R}
          y2={LANE_TOP + i * LANE_H}
          stroke="var(--color-line)"
          strokeWidth="1"
        />
      ))}
      <line
        x1={PLOT_L}
        y1={LANE_BOT}
        x2={PLOT_R}
        y2={LANE_BOT}
        stroke="var(--color-line)"
        strokeWidth="1"
      />

      {/* vertical time-tick gridlines */}
      {ticks.map((t) => (
        <line
          key={`vtick-${t.label}`}
          x1={tX(t.t)}
          y1={LANE_TOP}
          x2={tX(t.t)}
          y2={LANE_BOT}
          stroke="var(--color-line-2)"
          strokeWidth="1"
          strokeDasharray={t.t === 1 ? undefined : "2 3"}
        />
      ))}

      {/* time-axis labels — top */}
      {ticks.map((t) => (
        <text
          key={`ttop-${t.label}`}
          x={tX(t.t)}
          y={22}
          textAnchor="middle"
          className="fill-ink-3 font-mono"
          fontSize="9"
        >
          {t.label}
        </text>
      ))}
      {/* time-axis labels — bottom mirror (subtle) */}
      {ticks.map((t) => (
        <text
          key={`tbot-${t.label}`}
          x={tX(t.t)}
          y={H - 12}
          textAnchor="middle"
          className="fill-ink-3 font-mono"
          fontSize="8"
        >
          {t.label === "NOW" || t.label === "6W AGO" ? "" : "|"}
        </text>
      ))}

      {/* NOW indicator — thick line + label */}
      <line
        x1={tX(1)}
        y1={LANE_TOP - 6}
        x2={tX(1)}
        y2={LANE_BOT + 6}
        stroke="var(--color-signal)"
        strokeWidth="1.4"
      />

      {/* lane labels (left gutter) */}
      {LANES.map((name, i) => (
        <g key={name}>
          <text
            x={4}
            y={laneY(i) + 3}
            className="fill-ink font-mono"
            fontSize="10"
            fontWeight="600"
          >
            {name}
          </text>
          <text
            x={4}
            y={laneY(i) + 15}
            className="fill-ink-3 font-mono"
            fontSize="8"
          >
            [ 0{i + 1} ]
          </text>
        </g>
      ))}

      {/* ---------- LANE 01 · EPISODIC — discrete decision events ---------- */}
      <EpisodicLane />

      {/* ---------- LANE 02 · TEMPORAL — a stepped area chart of AUTH size ---------- */}
      <TemporalLane />

      {/* ---------- LANE 03 · SEMANTIC — persistent invariant bars ---------- */}
      <SemanticLane />

      {/* ---------- LANE 04 · PROCEDURAL — repeating pattern pulses ---------- */}
      <ProceduralLane />

      {/* ---------- LANE 05 · WORKING — active window at the right ---------- */}
      <WorkingLane />
    </svg>
  );
}

/* --- LANE 01 · EPISODIC ------------------------------------------- */
function EpisodicLane() {
  const y = laneY(0);
  const events = [
    { t: 0.06, label: "snake_case ✓", highlight: true },
    { t: 0.14 },
    { t: 0.24 },
    { t: 0.31 },
    { t: 0.4 },
    { t: 0.48, label: "no-any ban" },
    { t: 0.55 },
    { t: 0.63 },
    { t: 0.72 },
    { t: 0.81 },
    { t: 0.88, label: "trpc guard" },
    { t: 0.95 },
  ];
  return (
    <g>
      {events.map((e, i) => (
        <g key={i}>
          <circle
            cx={tX(e.t)}
            cy={y}
            r={e.highlight ? 4.5 : 2.6}
            fill={e.highlight ? "var(--color-route)" : "var(--color-ink-2)"}
          />
          {e.label && (
            <>
              <line
                x1={tX(e.t)}
                y1={y - 6}
                x2={tX(e.t)}
                y2={y - 14}
                stroke={
                  e.highlight ? "var(--color-route)" : "var(--color-ink-3)"
                }
                strokeWidth="1"
              />
              <text
                x={tX(e.t) + 6}
                y={y - 14}
                className={
                  e.highlight
                    ? "fill-route font-mono"
                    : "fill-ink-2 font-mono"
                }
                fontSize="8.5"
              >
                {e.label}
              </text>
            </>
          )}
        </g>
      ))}
    </g>
  );
}

/* --- LANE 02 · TEMPORAL --------------------------------------------
   Stepped area chart of AUTH domain size across snapshots. Grows from
   12 files (6w) → 30 files (now). Rendered as small rects per tick.  */
function TemporalLane() {
  const laneTop = LANE_TOP + LANE_H;
  const laneBot = laneTop + LANE_H;
  const laneHeight = LANE_H;

  const points = [
    { t: 0.02, size: 12 },
    { t: 0.14, size: 14 },
    { t: 0.24, size: 15 },
    { t: 0.36, size: 18 },
    { t: 0.48, size: 22 },
    { t: 0.6, size: 24 },
    { t: 0.72, size: 25 },
    { t: 0.86, size: 28 },
    { t: 0.98, size: 30 },
  ];
  const maxSize = 32;
  const bandH = laneHeight * 0.72; // leave headroom for label

  return (
    <g>
      {/* domain-size step path */}
      {points.map((p, i) => {
        if (i === points.length - 1) return null;
        const x1 = tX(p.t);
        const x2 = tX(points[i + 1].t);
        const y1 = laneBot - (p.size / maxSize) * bandH;
        return (
          <g key={i}>
            <rect
              x={x1}
              y={y1}
              width={x2 - x1}
              height={laneBot - y1}
              fill="var(--color-route-soft)"
              stroke="var(--color-route)"
              strokeWidth="1"
            />
          </g>
        );
      })}
      {/* label anchor on the last snapshot */}
      <text
        x={tX(1) - 6}
        y={laneTop + 14}
        textAnchor="end"
        className="fill-ink-2 font-mono"
        fontSize="8.5"
      >
        AUTH · 12 → 30 files
      </text>
    </g>
  );
}

/* --- LANE 03 · SEMANTIC ----------------------------------------------
   A persistent invariant runs all the way across the lane. Two
   invariants shown — one always-holds (long unbroken bar), one broken
   briefly (a small red break marker mid-lane).                        */
function SemanticLane() {
  const y = laneY(2);
  const barH = 6;

  return (
    <g>
      {/* invariant 1 — persistent (route blue) */}
      <rect
        x={PLOT_L + 4}
        y={y - barH - 2}
        width={PLOT_W - 8}
        height={barH}
        fill="var(--color-route)"
      />
      <text
        x={PLOT_L + 8}
        y={y - barH - 6}
        className="fill-route font-mono"
        fontSize="8.5"
      >
        inv: TRPC ⊄ AUTH · held 100%
      </text>

      {/* invariant 2 — briefly broken (route with a red slice mid-lane) */}
      <rect
        x={PLOT_L + 4}
        y={y + 4}
        width={PLOT_W - 8}
        height={barH}
        fill="var(--color-ink-2)"
        opacity="0.75"
      />
      {/* the break */}
      <rect
        x={tX(0.38)}
        y={y + 4}
        width={tX(0.44) - tX(0.38)}
        height={barH}
        fill="var(--color-signal)"
      />
      <text
        x={PLOT_L + 8}
        y={y + barH + 14}
        className="fill-ink-2 font-mono"
        fontSize="8.5"
      >
        inv: no-cycle · broke 3w ago · restored
      </text>
    </g>
  );
}

/* --- LANE 04 · PROCEDURAL ------------------------------------------
   Repeating pulse markers spread across the lane, with a small badge
   summarising the co-change rate.                                    */
function ProceduralLane() {
  const y = laneY(3);
  const pulses = [0.08, 0.16, 0.26, 0.34, 0.44, 0.52, 0.61, 0.7, 0.78, 0.86, 0.94];

  return (
    <g>
      {pulses.map((t, i) => (
        <g key={i}>
          <line
            x1={tX(t)}
            y1={y - 8}
            x2={tX(t)}
            y2={y + 8}
            stroke="var(--color-ink-2)"
            strokeWidth="1.2"
            strokeDasharray="2 1.5"
          />
          <circle
            cx={tX(t)}
            cy={y}
            r="2"
            fill="var(--color-ink)"
          />
        </g>
      ))}
      <text
        x={PLOT_L + 8}
        y={y - 12}
        className="fill-ink-2 font-mono"
        fontSize="8.5"
      >
        pattern: route + auth_mw · 89% co-change
      </text>
    </g>
  );
}

/* --- LANE 05 · WORKING ---------------------------------------------
   Active "now" window occupying the rightmost slice of the lane, with
   a soft glow, an active dot at NOW, and a small callout.            */
function WorkingLane() {
  const y = laneY(4);
  const rectTop = y - LANE_H / 2 + 6;
  const rectBot = y + LANE_H / 2 - 6;
  const rectHeight = rectBot - rectTop;

  return (
    <g>
      {/* the active window */}
      <rect
        x={tX(0.86)}
        y={rectTop}
        width={tX(1) - tX(0.86)}
        height={rectHeight}
        fill="var(--color-signal-soft)"
        stroke="var(--color-signal)"
        strokeWidth="1"
      />

      {/* the pulse dot at NOW */}
      <circle cx={tX(1)} cy={y} r="4" fill="var(--color-signal)" />
      <circle
        cx={tX(1)}
        cy={y}
        r="9"
        fill="none"
        stroke="var(--color-signal)"
        strokeWidth="1"
        opacity="0.4"
      />

      {/* callout */}
      <text
        x={tX(0.85) - 6}
        y={y - 4}
        textAnchor="end"
        className="fill-ink-2 font-mono"
        fontSize="8.5"
      >
        2 sessions · 1 warning
      </text>
      <text
        x={tX(0.85) - 6}
        y={y + 8}
        textAnchor="end"
        className="fill-ink-3 font-mono"
        fontSize="8"
      >
        drift: AUTH +18 · unresolved
      </text>
    </g>
  );
}

/* ------------------------------------------------------------------- */
/* Legend / footer helpers                                              */
/* ------------------------------------------------------------------- */

function FooterStat({
  label,
  value,
  tone = "ink",
}: {
  label: string;
  value: string;
  tone?: "ink" | "signal";
}) {
  return (
    <div className="bg-paper px-5 py-4">
      <p className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-3">
        {label}
      </p>
      <p
        className={`mt-2 font-display text-xl font-semibold leading-none ${
          tone === "signal" ? "text-signal" : "text-ink"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Dot({ tone }: { tone: "route" | "ink" | "signal" }) {
  const cls =
    tone === "route"
      ? "bg-route"
      : tone === "signal"
      ? "bg-signal"
      : "bg-ink";
  return <span className={`inline-block h-2 w-2 rounded-none ${cls}`} />;
}
