"use client";

import { motion } from "motion/react";

/**
 * THE signature hero graphic — recast from an import graph fragment into a
 * literal neural diagram. Same information, biological vocabulary:
 *
 *   • Every file is a SOMA (cell body) — a small round node with a fringe
 *     of dendrite hairs. Ink stroke on paper.
 *   • Every import is an AXON — a curved route-blue path that terminates
 *     at a synapse (small filled dot) on the receiving cell.
 *   • The touched file is filled ink and radiates a red PAIN SIGNAL — three
 *     concentric rings pulsing outward. This is the danger propagating
 *     along its axons to every file that depends on it.
 *
 * Signal red is used exactly once — the pulse and the BLAST RADIUS callout
 * attached to it. Every other line is blue (a signal Carto discovered) or
 * ink (a file). The metaphor sells itself.
 *
 * Layout: target soma centered; 4 upstream cells (files that import it) on
 * the left; 4 downstream cells (files it imports) on the right. Deterministic
 * — same repo shape always draws the same neuron.
 */

type Cell = {
  id: string;
  x: number;
  y: number;
  label: string;
  side: "upstream" | "downstream";
};

const TARGET_X = 280;
const TARGET_Y = 240;
const TARGET_R = 30;

const cells: Cell[] = [
  // upstream — files that import the target → their axons converge on the soma
  { id: "route", x: 65, y: 60, label: "route.ts", side: "upstream" },
  { id: "server", x: 65, y: 180, label: "server.ts", side: "upstream" },
  { id: "mw", x: 65, y: 300, label: "middleware.ts", side: "upstream" },
  { id: "cli", x: 65, y: 420, label: "cli.ts", side: "upstream" },
  // downstream — files the target imports → dendrites reaching outward
  { id: "jwt", x: 495, y: 60, label: "utils/jwt.ts", side: "downstream" },
  { id: "db", x: 495, y: 180, label: "db/client.ts", side: "downstream" },
  { id: "log", x: 495, y: 300, label: "log.ts", side: "downstream" },
  { id: "cfg", x: 495, y: 420, label: "config.ts", side: "downstream" },
];

const CELL_R = 12;

export function MapDiagram() {
  return (
    <motion.svg
      viewBox="0 0 560 480"
      className="h-auto w-full"
      initial="hidden"
      animate="show"
      variants={container}
      role="img"
      aria-label="Diagram. The file you edit — auth/session.ts — sits at the center. Four files import it and four files it depends on branch outward. A red signal radiates from the edited file, showing the change will break 83 connected files."
    >
      <defs>
        {/* faint blueprint grid — reused from the original */}
        <pattern
          id="ns-grid"
          width="28"
          height="28"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M28 0H0V28"
            fill="none"
            stroke="var(--color-line-2)"
            strokeWidth="1"
          />
        </pattern>

        {/* radial red pulse — the pain signal */}
        <radialGradient id="ns-pulse" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-signal)" stopOpacity="0.55" />
          <stop offset="60%" stopColor="var(--color-signal)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--color-signal)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="560" height="480" fill="url(#ns-grid)" />

      {/* --- pain signal · concentric rings behind the soma --- */}
      <PainSignal x={TARGET_X} y={TARGET_Y} />

      {/* --- axons (drawn under cells so nodes overlay endings) --- */}
      {cells.map((c) => (
        <Axon key={`axon-${c.id}`} cell={c} />
      ))}

      {/* --- satellite cell bodies --- */}
      {cells.map((c) => (
        <CellBody key={c.id} cell={c} />
      ))}

      {/* --- the target soma (large, filled) --- */}
      <TargetSoma />

      {/* --- callout · WILL BREAK 83 · centered above the soma --- */}
      <motion.g variants={fade}>
        {/* leader from soma top up to the box */}
        <path
          d={`M ${TARGET_X},${TARGET_Y - TARGET_R} L ${TARGET_X},60`}
          fill="none"
          stroke="var(--color-signal)"
          strokeWidth="1.3"
          strokeDasharray="4 3"
        />
        <circle
          cx={TARGET_X}
          cy={TARGET_Y - TARGET_R}
          r="3"
          fill="var(--color-signal)"
        />
        <rect
          x={TARGET_X - 52}
          y={12}
          width={104}
          height={48}
          fill="var(--color-signal-soft)"
          stroke="var(--color-signal)"
          strokeWidth="1.3"
        />
        <text
          x={TARGET_X}
          y={31}
          textAnchor="middle"
          className="fill-signal font-mono"
          fontSize="8.5"
        >
          WILL BREAK
        </text>
        <text
          x={TARGET_X}
          y={51}
          textAnchor="middle"
          className="fill-signal font-display"
          fontSize="18"
          fontWeight={700}
        >
          83 files
        </text>
      </motion.g>

      {/* --- target label under soma --- */}
      <motion.g variants={fade}>
        <text
          x={TARGET_X}
          y={TARGET_Y + TARGET_R + 20}
          textAnchor="middle"
          className="fill-ink font-mono"
          fontSize="10"
          fontWeight={600}
        >
          auth/session.ts
        </text>
        <text
          x={TARGET_X}
          y={TARGET_Y + TARGET_R + 34}
          textAnchor="middle"
          className="fill-signal font-mono"
          fontSize="8"
        >
          ● YOU EDIT THIS
        </text>
      </motion.g>
    </motion.svg>
  );
}

/**
 * The pain signal — three concentric rings + a soft radial gradient behind
 * the soma. The rings animate their opacity in a stagger so the whole thing
 * feels like it's pulsing outward.
 */
function PainSignal({ x, y }: { x: number; y: number }) {
  return (
    <motion.g variants={fade}>
      {/* soft glow */}
      <circle cx={x} cy={y} r={78} fill="url(#ns-pulse)" />
      {/* three pulse rings */}
      {[42, 56, 72].map((r, i) => (
        <motion.circle
          key={r}
          cx={x}
          cy={y}
          r={r}
          fill="none"
          stroke="var(--color-signal)"
          strokeWidth="1"
          strokeDasharray="3 5"
          animate={{ opacity: [0.55, 0.12, 0.55] }}
          transition={{
            duration: 2.4,
            delay: i * 0.35,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ))}
    </motion.g>
  );
}

/**
 * A curved axon from a satellite cell to the target soma. Direction of
 * signal flow doesn't matter visually — Carto's pain-signal pulses outward
 * along all connected axons regardless of import direction. Curve is a
 * simple quadratic Bézier that arches away from the line-of-sight so
 * multiple axons stay legible.
 */
function Axon({ cell }: { cell: Cell }) {
  const start = { x: cell.x, y: cell.y };
  const end = { x: TARGET_X, y: TARGET_Y };
  const midX = (start.x + end.x) / 2;
  // arch axon slightly — upstream cells arch downward, downstream upward
  const midY = (start.y + end.y) / 2 + (cell.side === "upstream" ? 34 : -34);

  // Trim endpoint so axon terminates just outside soma edge
  const dx = end.x - midX;
  const dy = end.y - midY;
  const len = Math.hypot(dx, dy);
  const trimmed = {
    x: +(end.x - (dx / len) * (TARGET_R + 3)).toFixed(3),
    y: +(end.y - (dy / len) * (TARGET_R + 3)).toFixed(3),
  };

  const cellDx = start.x - midX;
  const cellDy = start.y - midY;
  const cellLen = Math.hypot(cellDx, cellDy);
  const startTrim = {
    x: +(start.x - (cellDx / cellLen) * (CELL_R + 2)).toFixed(3),
    y: +(start.y - (cellDy / cellLen) * (CELL_R + 2)).toFixed(3),
  };

  return (
    <motion.g variants={fade}>
      <motion.path
        d={`M ${startTrim.x},${startTrim.y} Q ${midX},${midY} ${trimmed.x},${trimmed.y}`}
        fill="none"
        stroke="var(--color-route)"
        strokeWidth="1.4"
        strokeLinecap="round"
        variants={draw}
      />
      {/* synapse dot at the soma end */}
      <circle
        cx={trimmed.x}
        cy={trimmed.y}
        r="2.6"
        fill="var(--color-route)"
      />
    </motion.g>
  );
}

/**
 * A satellite cell body — small circle with a fringe of tiny dendrite hairs
 * so it reads as a neuron rather than a bullet point. Ink stroke, paper
 * fill. Label sits just below the cell.
 */
function CellBody({ cell }: { cell: Cell }) {
  return (
    <motion.g variants={fade}>
      {/* dendrite hairs — 6 short radial lines around the cell */}
      <g stroke="var(--color-ink-2)" strokeWidth="0.9" strokeLinecap="round">
        {Array.from({ length: 6 }).map((_, i) => {
          const angle = (i / 6) * Math.PI * 2;
          const inner = CELL_R + 1;
          const outer = CELL_R + 5;
          return (
            <line
              key={i}
              x1={+(cell.x + Math.cos(angle) * inner).toFixed(3)}
              y1={+(cell.y + Math.sin(angle) * inner).toFixed(3)}
              x2={+(cell.x + Math.cos(angle) * outer).toFixed(3)}
              y2={+(cell.y + Math.sin(angle) * outer).toFixed(3)}
            />
          );
        })}
      </g>
      {/* cell body */}
      <circle
        cx={cell.x}
        cy={cell.y}
        r={CELL_R}
        fill="var(--color-panel)"
        stroke="var(--color-ink)"
        strokeWidth="1.3"
      />
      {/* nucleus */}
      <circle
        cx={cell.x}
        cy={cell.y}
        r={CELL_R * 0.35}
        fill="var(--color-ink)"
      />
      {/* label */}
      <text
        x={cell.x}
        y={cell.y + CELL_R + 18}
        textAnchor="middle"
        className="fill-ink-2 font-mono"
        fontSize="9"
      >
        {cell.label}
      </text>
    </motion.g>
  );
}

/**
 * The target soma — bigger, filled ink, with a fringe of dendrite hairs and
 * a slightly larger nucleus. Sits atop the pain-signal rings.
 */
function TargetSoma() {
  return (
    <motion.g variants={fade}>
      {/* dendrite hairs */}
      <g stroke="var(--color-ink)" strokeWidth="1.1" strokeLinecap="round">
        {Array.from({ length: 12 }).map((_, i) => {
          const angle = (i / 12) * Math.PI * 2;
          const inner = TARGET_R + 1;
          const outer = TARGET_R + 9;
          return (
            <line
              key={i}
              x1={+(TARGET_X + Math.cos(angle) * inner).toFixed(3)}
              y1={+(TARGET_Y + Math.sin(angle) * inner).toFixed(3)}
              x2={+(TARGET_X + Math.cos(angle) * outer).toFixed(3)}
              y2={+(TARGET_Y + Math.sin(angle) * outer).toFixed(3)}
            />
          );
        })}
      </g>
      <circle
        cx={TARGET_X}
        cy={TARGET_Y}
        r={TARGET_R}
        fill="var(--color-ink)"
        stroke="var(--color-ink)"
        strokeWidth="1.4"
      />
      <circle
        cx={TARGET_X}
        cy={TARGET_Y}
        r={TARGET_R * 0.4}
        fill="var(--color-signal)"
      />
    </motion.g>
  );
}

/*
 * Entrance is deliberately calm. Earlier the axons "drew" themselves in with
 * a staggered pathLength animation, which made the whole diagram look like it
 * was assembling as you scrolled to it. The map is meant to feel already
 * present — a snapshot of a repo Carto has already mapped — so everything now
 * settles in with one short, unified fade. The only sustained motion is the
 * ambient pain-signal pulse (defined on PainSignal), which reads as "alive"
 * rather than "loading".
 */
const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.015, delayChildren: 0 } },
};

const draw = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { duration: 0.45, ease: "easeOut" as const },
  },
};

const fade = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.45, ease: "easeOut" as const } },
};
