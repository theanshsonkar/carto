import Link from "next/link";

export function AnnounceBar() {
  return (
    <Link
      href="/scan"
      className="group block bg-ink text-paper/90 transition-colors hover:text-paper"
    >
      <div className="shell flex h-9 items-center justify-center gap-3 text-[0.78rem]">
        <span className="font-mono uppercase tracking-[0.18em] text-route">
          [ New ]
        </span>
        <span className="truncate">
          Try Carto on any public repo — paste a GitHub URL, get the full map.
        </span>
        <span
          aria-hidden
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        >
          →
        </span>
      </div>
    </Link>
  );
}
