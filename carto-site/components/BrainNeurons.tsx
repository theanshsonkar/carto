"use client";

import { motion } from "motion/react";

/**
 * The hero figure — a literal nervous system. A brain drawn in blueprint ink
 * on paper, its interior threaded with a route-blue neuron network (files and
 * the import edges between them). One node carries a red pain signal — the
 * concentric rings that mean "touch this and it propagates". Same semantics as
 * the rest of the site: blue = a connection Carto found, red = this could break.
 *
 * Entrance is a single calm fade — the brain is meant to feel already present,
 * not to assemble itself as you arrive. The only sustained motion is the red
 * pulse and a soft "firing" twinkle on a few synapses, so it reads as alive
 * rather than loading.
 */

// interior neuron nodes (inside the brain silhouette)
const NODES = [
  { x: 175, y: 175 },
  { x: 235, y: 168 },
  { x: 300, y: 172 },
  { x: 370, y: 190 },
  { x: 205, y: 235 },
  { x: 370, y: 245 },
  { x: 255, y: 282 },
  { x: 345, y: 280 },
];

// synapses that periodically "fire" (index into NODES)
const FIRING = [1, 3, 4, 7];

const SIGNAL = { x: 285, y: 240 };

const BRAIN_PATH =
  "M 120,250 C 92,205 96,150 140,120 C 150,88 195,78 220,100 C 240,80 280,84 292,110 C 315,92 352,98 360,128 C 388,116 424,132 424,166 C 452,178 456,222 428,244 C 448,262 442,298 410,302 C 408,320 386,328 366,318 L 360,352 C 358,368 340,368 336,352 L 332,314 C 292,326 214,330 168,308 C 132,298 110,286 120,250 Z";

export function BrainNeurons() {
  return (
    <motion.svg
      viewBox="0 0 560 440"
      className="h-auto w-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      role="img"
      aria-label="A brain drawn as a blueprint, its interior threaded with a network of connected nodes — files and the imports between them. One central node radiates a red signal, showing how a single change propagates across the whole system."
    >
      <defs>
        <clipPath id="brain-clip">
          <path d={BRAIN_PATH} />
        </clipPath>
      </defs>

      {/* outline */}
      <path
        d={BRAIN_PATH}
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />

      {/* gyri folds — curvy, hugging the contour */}
      <g
        clipPath="url(#brain-clip)"
        fill="none"
        stroke="var(--color-ink-3)"
        strokeWidth="1.3"
        strokeLinecap="round"
      >
        <path d="M 138,150 C 165,135 175,165 200,150 C 225,135 240,165 265,152" />
        <path d="M 285,135 C 310,155 330,132 355,150 C 380,168 400,140 420,160" />
        <path d="M 130,205 C 160,190 185,215 215,200" />
        <path d="M 360,200 C 385,188 405,210 428,198" />
        <path d="M 150,285 C 185,270 215,292 250,278" />
        <path d="M 300,285 C 330,272 360,292 395,278" />
      </g>

      {/* neuron network */}
      <g clipPath="url(#brain-clip)">
        {/* synapse edges */}
        <g
          fill="none"
          stroke="var(--color-route)"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M 175,175 Q 205,150 235,168" />
          <path d="M 235,168 Q 275,150 300,172" />
          <path d="M 300,172 Q 340,165 370,190" />
          <path d="M 175,175 Q 165,215 205,235" />
          <path d="M 205,235 Q 250,225 285,240" />
          <path d="M 285,240 Q 330,235 370,245" />
          <path d="M 300,172 Q 300,205 285,240" />
          <path d="M 235,168 Q 220,205 205,235" />
          <path d="M 205,235 Q 215,275 255,282" />
          <path d="M 285,240 Q 305,275 345,280" />
          <path d="M 370,190 Q 395,215 370,245" />
        </g>

        {/* neuron nodes */}
        {NODES.map((n, i) => (
          <g key={i}>
            <circle
              cx={n.x}
              cy={n.y}
              r={7}
              fill="var(--color-paper)"
              stroke="var(--color-ink)"
              strokeWidth="1.6"
            />
            {FIRING.includes(i) && (
              <motion.circle
                cx={n.x}
                cy={n.y}
                r={3}
                fill="var(--color-route)"
                animate={{ opacity: [0.15, 1, 0.15] }}
                transition={{
                  duration: 2.2,
                  delay: (i % 4) * 0.5,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
            )}
          </g>
        ))}

        {/* pain-signal node — red, pulsing rings */}
        {[30, 20].map((r, i) => (
          <motion.circle
            key={r}
            cx={SIGNAL.x}
            cy={SIGNAL.y}
            r={r}
            fill="none"
            stroke="var(--color-signal)"
            strokeWidth="1"
            strokeDasharray="3 5"
            animate={{ opacity: [0.5, 0.12, 0.5] }}
            transition={{
              duration: 2.4,
              delay: i * 0.4,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ))}
        <circle cx={SIGNAL.x} cy={SIGNAL.y} r={9} fill="var(--color-ink)" />
        <circle cx={SIGNAL.x} cy={SIGNAL.y} r={3.5} fill="var(--color-signal)" />
      </g>
    </motion.svg>
  );
}
