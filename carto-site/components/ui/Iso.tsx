/**
 * Iso — the blueprint icon family.
 *
 * A tight set of small technical illustrations used across the site as
 * capability marks. Every icon obeys the same rules so they read as one
 * system:
 *
 *   • 48×48 viewBox
 *   • 1.5px `currentColor` stroke for every outline
 *   • Exactly one filled `route` element per icon — the "point" of the mark
 *   • No signal (red) here — signal is reserved for real danger, not decoration
 *
 * Consumed with `<Iso.Structure className="text-ink-3" />` so the outer
 * color is set by the parent, but the blue accent survives dark/light modes.
 *
 * If you add a new icon, keep the invariants above or the family breaks.
 */

const R = "var(--color-route)";
const stroke = { stroke: "currentColor", strokeWidth: 1.5, fill: "none" } as const;

type IconProps = { className?: string; size?: number; ariaLabel?: string };

function IconShell({
  children,
  className,
  size = 48,
  ariaLabel,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      role={ariaLabel ? "img" : "presentation"}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {children}
    </svg>
  );
}

/* ---- 01 · Structure — an import graph fragment ---------------------- */
function Structure(p: IconProps) {
  return (
    <IconShell {...p}>
      <line x1="12" y1="12" x2="36" y2="12" {...stroke} />
      <line x1="12" y1="12" x2="24" y2="36" {...stroke} />
      <line x1="36" y1="12" x2="24" y2="36" {...stroke} />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <circle cx="36" cy="12" r="3" fill="currentColor" />
      {/* the accent — the "target" node */}
      <rect x="20" y="32" width="8" height="8" fill={R} />
    </IconShell>
  );
}

/* ---- 02 · Memory — five stacked layers, one active ------------------ */
function Memory(p: IconProps) {
  return (
    <IconShell {...p}>
      {[10, 17, 24, 31, 38].map((y, i) => (
        <rect
          key={y}
          x="8"
          y={y}
          width="32"
          height="4"
          fill={i === 2 ? R : "none"}
          {...(i === 2
            ? { stroke: R, strokeWidth: 1.5 }
            : { stroke: "currentColor", strokeWidth: 1.5 })}
        />
      ))}
    </IconShell>
  );
}

/* ---- 03 · Prediction — a needle gauge from 0 to 1 ------------------- */
function Prediction(p: IconProps) {
  return (
    <IconShell {...p}>
      {/* the arc */}
      <path d="M8 34 A16 16 0 0 1 40 34" {...stroke} />
      {/* the tick marks */}
      <line x1="8" y1="34" x2="10" y2="30" {...stroke} />
      <line x1="24" y1="18" x2="24" y2="14" {...stroke} />
      <line x1="40" y1="34" x2="38" y2="30" {...stroke} />
      {/* the needle — pointing at ~0.87 */}
      <line
        x1="24"
        y1="34"
        x2="36"
        y2="22"
        stroke={R}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="24" cy="34" r="2.5" fill={R} />
    </IconShell>
  );
}

/* ---- 04 · Timeline — commits on a rail, one focal marker ------------- */
function Timeline(p: IconProps) {
  return (
    <IconShell {...p}>
      <line x1="6" y1="24" x2="42" y2="24" {...stroke} />
      {[10, 18, 34, 42].map((x) => (
        <line key={x} x1={x} y1="20" x2={x} y2="28" {...stroke} />
      ))}
      {/* the focal event */}
      <rect
        x="24"
        y="18"
        width="4"
        height="12"
        fill={R}
        transform="rotate(45 26 24)"
      />
    </IconShell>
  );
}

/* ---- 05 · Wiring — many tools converge into one map ------------------ */
function Wiring(p: IconProps) {
  return (
    <IconShell {...p}>
      {/* four outer tool nodes */}
      <rect x="4" y="10" width="6" height="6" {...stroke} />
      <rect x="4" y="32" width="6" height="6" {...stroke} />
      <rect x="38" y="10" width="6" height="6" {...stroke} />
      <rect x="38" y="32" width="6" height="6" {...stroke} />
      {/* the map — accent block */}
      <rect x="20" y="20" width="8" height="8" fill={R} />
      {/* the wires */}
      <line x1="10" y1="13" x2="20" y2="22" {...stroke} />
      <line x1="10" y1="35" x2="20" y2="26" {...stroke} />
      <line x1="38" y1="13" x2="28" y2="22" {...stroke} />
      <line x1="38" y1="35" x2="28" y2="26" {...stroke} />
    </IconShell>
  );
}

/* ---- 06 · Radius — a hotspot with concentric reach rings ------------ */
function Radius(p: IconProps) {
  return (
    <IconShell {...p}>
      <circle cx="24" cy="24" r="18" {...stroke} strokeDasharray="2 3" />
      <circle cx="24" cy="24" r="10" {...stroke} strokeDasharray="2 3" />
      <rect x="20" y="20" width="8" height="8" fill={R} />
    </IconShell>
  );
}

/* ---- 07 · Diff — a validate_diff / gate mark ------------------------ */
function Diff(p: IconProps) {
  return (
    <IconShell {...p}>
      {/* the file */}
      <rect x="8" y="6" width="22" height="30" {...stroke} />
      <line x1="12" y1="14" x2="26" y2="14" {...stroke} />
      <line x1="12" y1="20" x2="22" y2="20" {...stroke} />
      <line x1="12" y1="26" x2="24" y2="26" {...stroke} />
      {/* the stamp — approval */}
      <rect x="24" y="26" width="16" height="16" fill={R} />
      <path
        d="M28 34 L31 37 L37 30"
        stroke="var(--color-paper)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconShell>
  );
}

export const Iso = {
  Structure,
  Memory,
  Prediction,
  Timeline,
  Wiring,
  Radius,
  Diff,
};
