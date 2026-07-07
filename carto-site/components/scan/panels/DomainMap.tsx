"use client";

import { motion } from "motion/react";
import type { Domain, CrossDomainViolation } from "../report-data";

/**
 * The signature hero visualization — the actual "map" the product is named
 * after. Domains are rendered as circles on a blueprint grid, sized by file
 * count (sqrt scale so one giant doesn't crush the rest), and stroked by
 * stability (safe / ink / signal).
 *
 * Cross-domain violations are drawn as short red dashed segments between
 * the two offending domains — the same "signal-only-when-danger" contract
 * used across the rest of the design system.
 *
 * Static positions: largest domain in the center, the rest in an even ring
 * around it. Deterministic — same report always draws the same map.
 */

type Placed = Domain & { x: number; y: number; r: number; index: number };

const W = 780;
const H = 460;
const CX = W / 2;
const CY = H / 2;
const ORBIT = 165; // ring radius for non-center domains
const R_MIN = 32;
const R_MAX = 74;

export function DomainMap({
  domains,
  crossDomain,
}: {
  domains: Domain[];
  crossDomain: CrossDomainViolation[];
}) {
  const sorted = [...domains].sort((a, b) => b.files - a.files);
  const maxFiles = Math.max(...sorted.map((d) => d.files), 1);

  const placed: Placed[] = sorted.map((d, i) => {
    const r = R_MIN + Math.sqrt(d.files / maxFiles) * (R_MAX - R_MIN);
    if (i === 0) {
      return { ...d, x: CX, y: CY, r, index: i };
    }
    const ringSize = sorted.length - 1;
    const angle = ((i - 1) / ringSize) * Math.PI * 2 - Math.PI / 2;
    return {
      ...d,
      x: CX + Math.cos(angle) * ORBIT,
      y: CY + Math.sin(angle) * ORBIT,
      r,
      index: i,
    };
  });

  // Map domain name -> placed node for edge lookup
  const byName = new Map<string, Placed>();
  for (const p of placed) byName.set(p.name, p);

  // Convert cross-domain violations into segments between placed circles
  const edges = crossDomain
    .map((v) => {
      const from = byName.get(v.fromDomain);
      const to = byName.get(v.toDomain);
      if (!from || !to) return null;
      return { from, to, kind: v.kind };
    })
    .filter(Boolean) as { from: Placed; to: Placed; kind: string }[];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Domain map of the repository. ${sorted.length} domains clustered from imports.`}
    >
      <defs>
        <pattern
          id="dm-grid"
          width="26"
          height="26"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M26 0H0V26"
            fill="none"
            stroke="var(--color-line-2)"
            strokeWidth="1"
          />
        </pattern>

        {/* Very faint axis crosshair through the origin — reads as drafting paper */}
        <marker
          id="dm-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerUnits="strokeWidth"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="var(--color-signal)" />
        </marker>
      </defs>

      <rect width={W} height={H} fill="url(#dm-grid)" />

      {/* Origin crosshair — subtle drafting reference */}
      <g opacity="0.55">
        <line
          x1={CX - 12}
          y1={CY}
          x2={CX + 12}
          y2={CY}
          stroke="var(--color-line)"
          strokeWidth="1"
        />
        <line
          x1={CX}
          y1={CY - 12}
          x2={CX}
          y2={CY + 12}
          stroke="var(--color-line)"
          strokeWidth="1"
        />
      </g>

      {/* Ring guide — a hairline circle where the outer domains sit */}
      <motion.circle
        cx={CX}
        cy={CY}
        r={ORBIT}
        fill="none"
        stroke="var(--color-line)"
        strokeWidth="1"
        strokeDasharray="2 5"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.6 }}
        transition={{ duration: 0.6, delay: 0.05 }}
      />

      {/* Cross-domain violation edges — always red, always dashed */}
      {edges.map((e, i) => (
        <motion.line
          key={`edge-${i}`}
          x1={e.from.x}
          y1={e.from.y}
          x2={e.to.x}
          y2={e.to.y}
          stroke="var(--color-signal)"
          strokeWidth="1.4"
          strokeDasharray="6 4"
          markerEnd="url(#dm-arrow)"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 0.85 }}
          transition={{ duration: 0.7, delay: 0.35 + i * 0.08 }}
        />
      ))}

      {/* Domain circles */}
      {placed.map((p, i) => (
        <DomainCircle key={p.name} node={p} isCenter={i === 0} delay={0.1 + i * 0.05} />
      ))}

      {/* Legend, bottom-left */}
      <g transform="translate(16, 428)">
        <LegendDot color="safe" x={0} label="stable" />
        <LegendDot color="ink" x={82} label="drifting" />
        <LegendDot color="signal" x={168} label="churning" />
        <text
          x={252}
          y={9}
          className="fill-ink-3 font-mono"
          fontSize="9"
        >
          — — cross-domain violation
        </text>
      </g>

      {/* Scale hint, bottom-right */}
      <text
        x={W - 16}
        y={437}
        textAnchor="end"
        className="fill-ink-3 font-mono"
        fontSize="9"
      >
        SIZE ∝ √FILE_COUNT
      </text>
    </svg>
  );
}

function DomainCircle({
  node,
  isCenter,
  delay,
}: {
  node: Placed;
  isCenter: boolean;
  delay: number;
}) {
  const stroke = strokeFor(node.stability);
  const fill = fillFor(node.stability);
  const textFill = "fill-ink";
  // Place the label below the circle
  const labelY = node.y + node.r + 16;
  const countY = labelY + 12;

  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.45, delay }}
      style={{ transformOrigin: `${node.x}px ${node.y}px` }}
    >
      <circle
        cx={node.x}
        cy={node.y}
        r={node.r}
        fill={fill}
        stroke={stroke}
        strokeWidth={isCenter ? 2 : 1.4}
      />
      {isCenter && (
        <circle
          cx={node.x}
          cy={node.y}
          r={node.r - 4}
          fill="none"
          stroke={stroke}
          strokeWidth="0.9"
          strokeDasharray="2 4"
          opacity="0.7"
        />
      )}
      <text
        x={node.x}
        y={node.y + 3}
        textAnchor="middle"
        className={`${textFill} font-mono`}
        fontSize={isCenter ? 12 : 10.5}
        fontWeight={600}
      >
        {node.name}
      </text>
      {/* below-circle label with file count */}
      <text
        x={node.x}
        y={labelY}
        textAnchor="middle"
        className="fill-ink-3 font-mono"
        fontSize="9"
      >
        {node.files.toLocaleString()} files
      </text>
      <text
        x={node.x}
        y={countY}
        textAnchor="middle"
        className="fill-ink-3 font-mono"
        fontSize="8"
        opacity="0.7"
      >
        {node.stability}
      </text>
    </motion.g>
  );
}

function strokeFor(kind: Domain["stability"]): string {
  return {
    stable: "var(--color-safe)",
    drifting: "var(--color-ink)",
    churning: "var(--color-signal)",
  }[kind];
}

function fillFor(kind: Domain["stability"]): string {
  return {
    stable: "var(--color-safe-soft)",
    drifting: "var(--color-panel)",
    churning: "var(--color-signal-soft)",
  }[kind];
}

function LegendDot({
  color,
  x,
  label,
}: {
  color: "safe" | "ink" | "signal";
  x: number;
  label: string;
}) {
  const dotColor = {
    safe: "var(--color-safe)",
    ink: "var(--color-ink)",
    signal: "var(--color-signal)",
  }[color];
  return (
    <g transform={`translate(${x}, 0)`}>
      <circle cx="5" cy="5" r="4.5" fill={dotColor} />
      <text
        x="14"
        y="9"
        className="fill-ink-3 font-mono"
        fontSize="9"
      >
        {label}
      </text>
    </g>
  );
}
