import Link from "next/link";

/**
 * The mark: a hollow square (a codebase) with an arrow-like tick inside it
 * pointing outward — the map arrow. Corner registration hints at "you are
 * mapping this territory."
 */
export function Logo() {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6 text-ink"
        fill="none"
        aria-hidden
      >
        {/* territory box */}
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {/* inner nodes (like graph vertices) */}
        <circle cx="8" cy="8" r="1.4" fill="currentColor" />
        <circle cx="16" cy="8" r="1.4" fill="currentColor" />
        <circle cx="12" cy="16" r="1.4" fill="currentColor" />
        {/* edges */}
        <path
          d="M8 8L16 8M8 8L12 16M16 8L12 16"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
      <span className="font-display text-[1.05rem] font-medium tracking-tight text-ink">
        carto
      </span>
    </Link>
  );
}
