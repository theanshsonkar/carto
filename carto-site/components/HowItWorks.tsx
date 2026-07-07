import { Eyebrow } from "./ui/Eyebrow";
import { Reveal } from "./ui/Reveal";

/**
 * HowItWorks — 4-step walkthrough. Each step gets a mini-visual rendered
 * inline as SVG so the section carries real weight (Supermemory's move: give
 * every step its own graphic). Reads: wire → index → decide → predict.
 *
 * Every visual obeys the site palette: paper background, route-blue accent,
 * ink for structural lines. No gradients, no emoji, no stock illustration.
 */
export function HowItWorks() {
  return (
    <section id="how" className="border-b border-line bg-panel-2/40">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-[1.05fr_1fr] md:items-end">
            <h2 className="max-w-3xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
              Four steps. <span className="text-route">One command each.</span>
            </h2>
            <p className="max-w-md text-[1rem] leading-relaxed text-ink-2 md:justify-self-end md:text-right">
              Install once. Everything after runs on git hooks. Your AI never
              re-decides settled questions.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="mt-14 grid gap-px border border-line bg-line md:grid-cols-2">
            <Step
              n="01"
              tag="WIRE IN"
              title="One command detects every AI tool."
              body="carto init reads your repo and auto-registers Carto as an MCP server for every tool it finds on your machine. Restart. Done."
              visual={<WireVisual />}
            />
            <Step
              n="02"
              tag="INDEX"
              title="The map builds itself."
              body="Imports, routes, models, domains, blast radius — extracted from the source. Bitmap-backed so blast radius is a lookup, not a traversal."
              visual={<IndexVisual />}
            />
            <Step
              n="03"
              tag="REMEMBER"
              title="Every decision is written to disk."
              body="Every validate_diff, every architectural verdict, every drift event lands in one SQLite file. Next chat can ask, six weeks later."
              visual={<RememberVisual />}
            />
            <Step
              n="04"
              tag="PREDICT"
              title="Risky files surface before the PR."
              body="P(this file causes the next bug) blends blast radius × churn × interventions × coverage. Your AI sees the score before it proposes the diff."
              visual={<PredictVisual />}
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Step({
  n,
  tag,
  title,
  body,
  visual,
}: {
  n: string;
  tag: string;
  title: string;
  body: string;
  visual: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6 bg-paper p-7 md:p-10">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm text-ink-3">[ {n} ]</span>
        <span className="h-px flex-1 bg-line" />
        <Eyebrow>{tag}</Eyebrow>
      </div>

      <h3 className="font-display text-xl font-medium leading-snug text-ink md:text-2xl">
        {title}
      </h3>
      <p className="text-[0.95rem] leading-relaxed text-ink-2">{body}</p>

      <div className="mt-auto border border-line bg-panel/60 p-4">
        {visual}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mini-visuals — one per step. All 100% SVG, palette-locked.          */
/* ------------------------------------------------------------------ */

/** 01 — WIRE: 6 tools connect into the central Carto node. */
function WireVisual() {
  const tools = [
    { x: 20, y: 26, label: "cursor" },
    { x: 20, y: 60, label: "claude" },
    { x: 20, y: 94, label: "codex" },
    { x: 280, y: 26, label: "kiro" },
    { x: 280, y: 60, label: "zed" },
    { x: 280, y: 94, label: "copilot" },
  ];
  return (
    <svg viewBox="0 0 340 120" className="h-auto w-full" role="presentation">
      <defs>
        <pattern id="grid-wire" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="var(--color-line-2)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="340" height="120" fill="url(#grid-wire)" />

      {/* center Carto node */}
      <rect x="150" y="46" width="40" height="28" fill="var(--color-ink)" />
      <text x="170" y="63" textAnchor="middle" className="fill-paper font-mono" fontSize="10">carto</text>

      {tools.map((t) => {
        const isLeft = t.x < 170;
        return (
          <g key={t.label}>
            <line
              x1={isLeft ? t.x + 60 : t.x}
              y1={t.y + 8}
              x2={isLeft ? 150 : 190}
              y2={60}
              stroke="var(--color-route)"
              strokeWidth="1"
            />
            <rect x={t.x} y={t.y} width="60" height="16" fill="var(--color-panel)" stroke="var(--color-line)" />
            <text x={t.x + 30} y={t.y + 11} textAnchor="middle" className="fill-ink font-mono" fontSize="9">{t.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** 02 — INDEX: a rising bar-count animation of files parsed. */
function IndexVisual() {
  const bars = [
    { x: 20, h: 20, label: "js" },
    { x: 55, h: 34, label: "ts" },
    { x: 90, h: 62, label: "tsx" },
    { x: 125, h: 48, label: "py" },
    { x: 160, h: 30, label: "go" },
    { x: 195, h: 40, label: "rs" },
    { x: 230, h: 26, label: "sql" },
    { x: 265, h: 44, label: "md" },
  ];
  return (
    <svg viewBox="0 0 340 120" className="h-auto w-full" role="presentation">
      <defs>
        <pattern id="grid-idx" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="var(--color-line-2)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="340" height="120" fill="url(#grid-idx)" />

      {/* baseline */}
      <line x1="10" y1="95" x2="330" y2="95" stroke="var(--color-line)" strokeWidth="1" />

      {bars.map((b) => (
        <g key={b.label}>
          <rect
            x={b.x}
            y={95 - b.h}
            width="20"
            height={b.h}
            fill={b.label === "tsx" ? "var(--color-route)" : "var(--color-ink)"}
          />
          <text x={b.x + 10} y={110} textAnchor="middle" className="fill-ink-3 font-mono" fontSize="8">{b.label}</text>
        </g>
      ))}

      <text x="20" y="20" className="fill-ink-3 font-mono" fontSize="9">FILES BY LANG · 6,358</text>
    </svg>
  );
}

/** 03 — REMEMBER: episodic timeline with a locked verdict entry. */
function RememberVisual() {
  return (
    <svg viewBox="0 0 340 120" className="h-auto w-full" role="presentation">
      <defs>
        <pattern id="grid-mem" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="var(--color-line-2)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="340" height="120" fill="url(#grid-mem)" />

      {/* timeline rail */}
      <line x1="20" y1="60" x2="320" y2="60" stroke="var(--color-line)" strokeWidth="1" />

      {/* commits */}
      {[40, 80, 120, 160, 240, 280, 300].map((x) => (
        <circle key={x} cx={x} cy="60" r="2.5" fill="var(--color-ink-3)" />
      ))}

      {/* the anchored decision */}
      <line x1="200" y1="60" x2="200" y2="30" stroke="var(--color-route)" strokeWidth="1.5" />
      <rect x="130" y="14" width="140" height="30" fill="var(--color-route)" />
      <text x="200" y="27" textAnchor="middle" className="fill-paper font-mono" fontSize="9">
        did_we_discuss_this
      </text>
      <text x="200" y="39" textAnchor="middle" className="fill-paper/80 font-mono" fontSize="8">
        ✓ snake_case · verdict returned
      </text>

      <text x="20" y="106" className="fill-ink-3 font-mono" fontSize="9">
        6 WEEKS AGO
      </text>
      <text x="320" y="106" textAnchor="end" className="fill-ink-3 font-mono" fontSize="9">
        NEW CHAT
      </text>
    </svg>
  );
}

/** 04 — PREDICT: a gauge sliding from safe to danger. */
function PredictVisual() {
  return (
    <svg viewBox="0 0 340 120" className="h-auto w-full" role="presentation">
      <defs>
        <pattern id="grid-pred" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="var(--color-line-2)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="340" height="120" fill="url(#grid-pred)" />

      {/* gauge track */}
      <rect x="20" y="60" width="300" height="14" fill="var(--color-panel)" stroke="var(--color-line)" />

      {/* gradient fill — safe → signal */}
      <rect x="20" y="60" width="60" height="14" fill="var(--color-safe)" opacity="0.35" />
      <rect x="80" y="60" width="120" height="14" fill="var(--color-route)" opacity="0.35" />
      <rect x="200" y="60" width="120" height="14" fill="var(--color-signal)" opacity="0.35" />

      {/* the needle */}
      <line x1="281" y1="46" x2="281" y2="88" stroke="var(--color-signal)" strokeWidth="2" />
      <polygon points="281,42 276,50 286,50" fill="var(--color-signal)" />

      {/* labels */}
      <text x="20" y="42" className="fill-ink-3 font-mono" fontSize="9">P(NEXT BUG)</text>
      <text x="20" y="102" className="fill-ink-3 font-mono" fontSize="8">0.00</text>
      <text x="170" y="102" textAnchor="middle" className="fill-ink-3 font-mono" fontSize="8">0.50</text>
      <text x="320" y="102" textAnchor="end" className="fill-ink-3 font-mono" fontSize="8">1.00</text>
      <text x="281" y="34" textAnchor="middle" className="fill-signal font-mono" fontSize="10" fontWeight="600">
        0.87
      </text>
    </svg>
  );
}
