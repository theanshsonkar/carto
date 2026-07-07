"use client";

import { motion } from "motion/react";
import { Reveal } from "./ui/Reveal";

/**
 * ReflexArc — the anatomical companion to AnchorBlock. Where AnchorBlock
 * carries the numbers (84µs · 7,567 files · 10.7× · 0 blind), this section
 * carries the picture: a proper reflex-arc diagram that shows *why* those
 * numbers matter.
 *
 * Three anatomical sites, left → right:
 *   • AI (the brain that proposes the diff)
 *   • CARTO (the ganglion where the reflex fires)
 *   • FILE (the muscle that would have moved)
 *
 * Signal flow:
 *   • Blue forward axon:   AI ─diff─→ CARTO
 *   • Faded blue axon:     CARTO ⇢ FILE  (what would happen without Carto)
 *   • Red reflex return:   CARTO ─HIGH─→ AI  (the microsecond veto)
 *
 * The reflex arc is a real anatomical structure — a pathway that bypasses
 * conscious thought to prevent injury. Carto is exactly that for AI-written
 * code: the reflex that fires between "AI proposes" and "user sees."
 */

// ---- geometry -----------------------------------------------------------

const W = 960;
const H = 340;

const AI = { cx: 140, cy: 170, r: 58 };
const CARTO = { cx: 480, cy: 170, r: 62 };
const FILE = { cx: 820, cy: 170, r: 54 };

export function ReflexArc() {
  return (
    <section className="border-t border-b border-line bg-panel/40 bp-grid">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-[1.1fr_1fr] md:items-end">
            <div>
              <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ink-3">
                [ THE REFLEX ARC · VALIDATE_DIFF ]
              </p>
              <h2 className="mt-6 max-w-3xl font-display text-4xl font-medium leading-[1.02] tracking-tight text-ink md:text-6xl">
                Sense. Signal.{" "}
                <span className="text-route">Reflex.</span>
              </h2>
            </div>
            <p className="max-w-md text-[1rem] leading-relaxed text-ink-2 md:justify-self-end md:text-right">
              A reflex arc bypasses the brain to protect the body. Carto does
              the same for AI-written code — verdict returns in{" "}
              <span className="font-mono text-signal">84 µs</span>, before
              the bad diff ever hits your screen.
            </p>
          </div>
        </Reveal>

        {/* --- the diagram --- */}
        <Reveal delay={0.1}>
          <div className="mt-14 border border-line bg-paper">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="font-mono text-[0.72rem] uppercase tracking-[0.16em] text-ink-3">
                [ REFLEX PATHWAY · ANATOMICAL VIEW ]
              </span>
              <span className="font-mono text-[0.72rem] text-ink-3">
                signal · sub-millisecond
              </span>
            </div>
            <div className="p-4 md:p-6">
              <ReflexSVG />
            </div>
            <div className="grid grid-cols-1 gap-px border-t border-line bg-line md:grid-cols-3">
              <StageCard
                index="01"
                title="AI · sends"
                body="Claude, Cursor, Codex — any AI tool proposes a diff. Standard MCP tools/call. It hasn't shown you the patch yet."
                dot="route"
              />
              <StageCard
                index="02"
                title="Carto · reflexes"
                body="In 84 microseconds, Carto scores blast radius, checks domain boundaries, mines prior decisions. Returns HIGH / MEDIUM / LOW."
                dot="signal"
              />
              <StageCard
                index="03"
                title="AI · revises"
                body="Bad diff blocked before render. AI reads the verdict, splits the change, asks a question, or picks a safer approach."
                dot="route"
              />
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.18}>
          <p className="mt-10 max-w-3xl text-[0.95rem] leading-relaxed text-ink-2">
            The reflex fires before the AI can send a bad instruction. You
            never see the risky diff. Your codebase never feels the touch.
            Same pathway your body uses to yank a hand off a hot stove —
            just built for source code.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------
//   THE SVG — three stations connected by an anatomical signal pathway
// ------------------------------------------------------------------------

function ReflexSVG() {
  return (
    <motion.svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      variants={container}
      role="img"
      aria-label="Reflex arc diagram. An AI proposes a diff, which travels to Carto (the reflex site). In 84 microseconds Carto fires a red signal back to the AI, blocking the diff before it reaches the file."
    >
      <defs>
        <pattern
          id="ra-grid"
          width="32"
          height="32"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M32 0H0V32"
            fill="none"
            stroke="var(--color-line-2)"
            strokeWidth="1"
          />
        </pattern>
        <marker
          id="ra-arrow-blue"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerUnits="strokeWidth"
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="var(--color-route)" />
        </marker>
        <marker
          id="ra-arrow-red"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerUnits="strokeWidth"
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="var(--color-signal)" />
        </marker>
      </defs>

      <rect width={W} height={H} fill="url(#ra-grid)" />

      {/* --- forward axon: AI → CARTO --- */}
      <ForwardAxon
        from={{ x: AI.cx + AI.r + 2, y: AI.cy }}
        to={{ x: CARTO.cx - CARTO.r - 2, y: CARTO.cy }}
        label="proposes diff"
        timing="t = 0"
      />

      {/* --- would-happen axon: CARTO → FILE (dimmed, would break) --- */}
      <BlockedAxon
        from={{ x: CARTO.cx + CARTO.r + 2, y: CARTO.cy }}
        to={{ x: FILE.cx - FILE.r - 2, y: FILE.cy }}
        label="blocked path"
      />

      {/* --- reflex return: CARTO → AI (red, curved up) --- */}
      <ReflexReturn
        from={{ x: CARTO.cx - 6, y: CARTO.cy - CARTO.r }}
        to={{ x: AI.cx + AI.r * 0.6, y: AI.cy - AI.r * 0.8 }}
      />

      {/* --- three stations --- */}
      <AIGlyph />
      <CartoGlyph />
      <FileGlyph />
    </motion.svg>
  );
}

// ------------------------------------------------------------------------
//   AI GLYPH — a stylized brain (soft asymmetric shape with lobes)
// ------------------------------------------------------------------------

function AIGlyph() {
  return (
    <motion.g variants={fade}>
      {/* brain silhouette: rounded blob with subtle hemisphere seam */}
      <path
        d={`M ${AI.cx - 46},${AI.cy - 18}
            C ${AI.cx - 58},${AI.cy - 48} ${AI.cx - 20},${AI.cy - 62} ${AI.cx - 4},${AI.cy - 46}
            C ${AI.cx + 6},${AI.cy - 62} ${AI.cx + 48},${AI.cy - 52} ${AI.cx + 48},${AI.cy - 18}
            C ${AI.cx + 62},${AI.cy - 4}  ${AI.cx + 56},${AI.cy + 30} ${AI.cx + 32},${AI.cy + 40}
            C ${AI.cx + 28},${AI.cy + 54} ${AI.cx - 20},${AI.cy + 56} ${AI.cx - 30},${AI.cy + 40}
            C ${AI.cx - 58},${AI.cy + 30} ${AI.cx - 60},${AI.cy - 2} ${AI.cx - 46},${AI.cy - 18} Z`}
        fill="var(--color-panel)"
        stroke="var(--color-ink)"
        strokeWidth="1.5"
      />
      {/* hemisphere seam */}
      <path
        d={`M ${AI.cx - 4},${AI.cy - 46}
            C ${AI.cx - 2},${AI.cy - 20} ${AI.cx - 8},${AI.cy + 20} ${AI.cx - 2},${AI.cy + 46}`}
        fill="none"
        stroke="var(--color-ink-2)"
        strokeWidth="1.1"
      />
      {/* a couple of gyri/lobes as internal curves */}
      <path
        d={`M ${AI.cx - 34},${AI.cy - 20} Q ${AI.cx - 20},${AI.cy - 10} ${AI.cx - 16},${AI.cy}`}
        fill="none"
        stroke="var(--color-ink-2)"
        strokeWidth="0.9"
      />
      <path
        d={`M ${AI.cx + 14},${AI.cy - 22} Q ${AI.cx + 26},${AI.cy - 6} ${AI.cx + 34},${AI.cy + 6}`}
        fill="none"
        stroke="var(--color-ink-2)"
        strokeWidth="0.9"
      />
      <path
        d={`M ${AI.cx - 30},${AI.cy + 10} Q ${AI.cx - 14},${AI.cy + 26} ${AI.cx},${AI.cy + 22}`}
        fill="none"
        stroke="var(--color-ink-2)"
        strokeWidth="0.9"
      />

      <StationLabel
        cx={AI.cx}
        cy={AI.cy + AI.r + 34}
        title="AI"
        subtitle="Cursor · Claude · Codex"
        eyebrow="STATION 01 · BRAIN"
      />
    </motion.g>
  );
}

// ------------------------------------------------------------------------
//   CARTO GLYPH — a ganglion / synapse cluster (the reflex site)
// ------------------------------------------------------------------------

function CartoGlyph() {
  return (
    <motion.g variants={fade}>
      {/* faint outer aura, blue */}
      <circle
        cx={CARTO.cx}
        cy={CARTO.cy}
        r={CARTO.r + 12}
        fill="var(--color-route-soft)"
        opacity="0.55"
      />
      {/* main soma */}
      <circle
        cx={CARTO.cx}
        cy={CARTO.cy}
        r={CARTO.r}
        fill="var(--color-panel)"
        stroke="var(--color-route)"
        strokeWidth="1.8"
      />
      {/* inner synapse cluster — three small connected cells to imply the ganglion */}
      <circle cx={CARTO.cx - 18} cy={CARTO.cy - 10} r="10" fill="var(--color-route-soft)" stroke="var(--color-route)" strokeWidth="1.2" />
      <circle cx={CARTO.cx + 20} cy={CARTO.cy - 6} r="9" fill="var(--color-route-soft)" stroke="var(--color-route)" strokeWidth="1.2" />
      <circle cx={CARTO.cx - 2} cy={CARTO.cy + 22} r="11" fill="var(--color-route-soft)" stroke="var(--color-route)" strokeWidth="1.2" />

      {/* synaptic connections between the inner cells */}
      <g stroke="var(--color-route)" strokeWidth="0.9" fill="none">
        <path d={`M ${CARTO.cx - 10},${CARTO.cy - 8} L ${CARTO.cx + 12},${CARTO.cy - 4}`} />
        <path d={`M ${CARTO.cx - 12},${CARTO.cy - 3} L ${CARTO.cx - 4},${CARTO.cy + 14}`} />
        <path d={`M ${CARTO.cx + 14},${CARTO.cy} L ${CARTO.cx + 4},${CARTO.cy + 16}`} />
      </g>

      {/* dendrite hairs around the periphery */}
      <g stroke="var(--color-route)" strokeWidth="1" strokeLinecap="round">
        {Array.from({ length: 14 }).map((_, i) => {
          const angle = (i / 14) * Math.PI * 2;
          const inner = CARTO.r + 1;
          const outer = CARTO.r + 10;
          return (
            <line
              key={i}
              x1={CARTO.cx + Math.cos(angle) * inner}
              y1={CARTO.cy + Math.sin(angle) * inner}
              x2={CARTO.cx + Math.cos(angle) * outer}
              y2={CARTO.cy + Math.sin(angle) * outer}
            />
          );
        })}
      </g>

      <StationLabel
        cx={CARTO.cx}
        cy={CARTO.cy + CARTO.r + 46}
        title="CARTO"
        subtitle="reflex · 84 µs"
        eyebrow="STATION 02 · GANGLION"
        tone="route"
      />
    </motion.g>
  );
}

// ------------------------------------------------------------------------
//   FILE GLYPH — a document with a red-X seal (this is what would break)
// ------------------------------------------------------------------------

function FileGlyph() {
  const w = 78;
  const h = 96;
  const x = FILE.cx - w / 2;
  const y = FILE.cy - h / 2;
  const fold = 20;

  return (
    <motion.g variants={fade}>
      {/* folded top corner */}
      <path
        d={`M ${x},${y} L ${x + w - fold},${y}
            L ${x + w},${y + fold} L ${x + w},${y + h}
            L ${x},${y + h} Z`}
        fill="var(--color-panel)"
        stroke="var(--color-ink)"
        strokeWidth="1.4"
      />
      <path
        d={`M ${x + w - fold},${y} L ${x + w - fold},${y + fold} L ${x + w},${y + fold}`}
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="1.2"
      />
      {/* file content lines */}
      <g stroke="var(--color-ink-2)" strokeWidth="0.9" strokeLinecap="round">
        <line x1={x + 10} y1={y + 32} x2={x + w - 12} y2={y + 32} />
        <line x1={x + 10} y1={y + 42} x2={x + w - 22} y2={y + 42} />
        <line x1={x + 10} y1={y + 52} x2={x + w - 16} y2={y + 52} />
        <line x1={x + 10} y1={y + 62} x2={x + w - 26} y2={y + 62} />
      </g>
      {/* red-X seal — the "would have broken" mark */}
      <g stroke="var(--color-signal)" strokeWidth="2.4" strokeLinecap="round" opacity="0.9">
        <line x1={FILE.cx - 14} y1={y + h - 22} x2={FILE.cx + 14} y2={y + h + 6} />
        <line x1={FILE.cx + 14} y1={y + h - 22} x2={FILE.cx - 14} y2={y + h + 6} />
      </g>

      <StationLabel
        cx={FILE.cx}
        cy={FILE.cy + FILE.r + 34}
        title="FILE"
        subtitle="spared · never touched"
        eyebrow="STATION 03 · TARGET"
      />
    </motion.g>
  );
}

// ------------------------------------------------------------------------
//   FORWARD / BLOCKED / REFLEX signal paths
// ------------------------------------------------------------------------

function ForwardAxon({
  from,
  to,
  label,
  timing,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  label: string;
  timing: string;
}) {
  const midX = (from.x + to.x) / 2;
  return (
    <motion.g variants={fade}>
      <motion.path
        d={`M ${from.x},${from.y} Q ${midX},${from.y - 8} ${to.x},${to.y}`}
        fill="none"
        stroke="var(--color-route)"
        strokeWidth="1.8"
        markerEnd="url(#ra-arrow-blue)"
        variants={draw}
      />
      <text
        x={midX}
        y={from.y - 20}
        textAnchor="middle"
        className="fill-ink-2 font-mono"
        fontSize="10"
      >
        {label}
      </text>
      <text
        x={midX}
        y={from.y - 6}
        textAnchor="middle"
        className="fill-route font-mono"
        fontSize="9"
      >
        {timing}
      </text>
    </motion.g>
  );
}

function BlockedAxon({
  from,
  to,
  label,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  label: string;
}) {
  const midX = (from.x + to.x) / 2;
  return (
    <motion.g variants={fade} opacity={0.55}>
      <motion.path
        d={`M ${from.x},${from.y} Q ${midX},${from.y + 8} ${to.x},${to.y}`}
        fill="none"
        stroke="var(--color-route)"
        strokeWidth="1.4"
        strokeDasharray="5 5"
        variants={draw}
      />
      <text
        x={midX}
        y={from.y + 22}
        textAnchor="middle"
        className="fill-ink-3 font-mono"
        fontSize="9"
      >
        {label}
      </text>
    </motion.g>
  );
}

function ReflexReturn({
  from,
  to,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
}) {
  // A high-arching curve back up and to the left — the reflex
  const midX = (from.x + to.x) / 2;
  const midY = Math.min(from.y, to.y) - 88;

  return (
    <motion.g variants={fade}>
      <motion.path
        d={`M ${from.x},${from.y} Q ${midX},${midY} ${to.x},${to.y}`}
        fill="none"
        stroke="var(--color-signal)"
        strokeWidth="2"
        strokeDasharray="6 4"
        markerEnd="url(#ra-arrow-red)"
        variants={draw}
      />
      {/* verdict badge on the reflex line */}
      <g transform={`translate(${midX - 46}, ${midY - 10})`}>
        <rect
          width="92"
          height="24"
          fill="var(--color-signal-soft)"
          stroke="var(--color-signal)"
          strokeWidth="1.2"
        />
        <text
          x="46"
          y="10"
          textAnchor="middle"
          className="fill-signal font-mono"
          fontSize="8.5"
        >
          REFLEX · t = 84 µs
        </text>
        <text
          x="46"
          y="20"
          textAnchor="middle"
          className="fill-signal font-mono"
          fontSize="8"
          fontWeight={600}
        >
          HIGH · BLOCKED
        </text>
      </g>
    </motion.g>
  );
}

function StationLabel({
  cx,
  cy,
  title,
  subtitle,
  eyebrow,
  tone = "ink",
}: {
  cx: number;
  cy: number;
  title: string;
  subtitle: string;
  eyebrow: string;
  tone?: "ink" | "route";
}) {
  const titleFill = tone === "route" ? "fill-route" : "fill-ink";
  return (
    <g>
      <text
        x={cx}
        y={cy - 12}
        textAnchor="middle"
        className="fill-ink-3 font-mono"
        fontSize="8.5"
      >
        {eyebrow}
      </text>
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        className={`${titleFill} font-display`}
        fontSize="15"
        fontWeight={600}
      >
        {title}
      </text>
      <text
        x={cx}
        y={cy + 18}
        textAnchor="middle"
        className="fill-ink-2 font-mono"
        fontSize="9"
      >
        {subtitle}
      </text>
    </g>
  );
}

// ------------------------------------------------------------------------
//   STAGE CARDS (below the diagram)
// ------------------------------------------------------------------------

function StageCard({
  index,
  title,
  body,
  dot,
}: {
  index: string;
  title: string;
  body: string;
  dot: "route" | "signal";
}) {
  const dotColor = dot === "signal" ? "bg-signal" : "bg-route";
  return (
    <div className="flex flex-col gap-3 bg-paper p-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className={`inline-block h-2 w-2 ${dotColor}`} />
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
          [ {index} ]
        </span>
      </div>
      <h3 className="font-display text-lg font-medium leading-snug text-ink">
        {title}
      </h3>
      <p className="text-[0.9rem] leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

// ---- motion variants ----------------------------------------------------

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const draw = {
  hidden: { pathLength: 0, opacity: 0 },
  show: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 0.9, ease: "easeInOut" as const },
  },
};

const fade = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.5 } },
};
