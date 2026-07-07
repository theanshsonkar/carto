/**
 * A single stat cell — one number, one label, one tiny caption.
 * Used in the report top-line stat bar and panel headers. Sharp corners,
 * mono caption, display-font number.
 */
export function StatCell({
  label,
  value,
  caption,
  tone = "ink",
  className = "",
}: {
  label: string;
  value: string | number;
  caption?: string;
  tone?: "ink" | "signal" | "route" | "safe";
  className?: string;
}) {
  const toneClass = {
    ink: "text-ink",
    signal: "text-signal",
    route: "text-route",
    safe: "text-safe",
  }[tone];

  return (
    <div className={`px-5 py-4 ${className}`}>
      <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
        {label}
      </p>
      <p
        className={`mt-2 font-display text-3xl font-semibold leading-none ${toneClass}`}
      >
        {value}
      </p>
      {caption && (
        <p className="mt-2 font-mono text-[0.7rem] text-ink-3">{caption}</p>
      )}
    </div>
  );
}
