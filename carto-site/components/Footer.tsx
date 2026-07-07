import Link from "next/link";

const columns = [
  {
    title: "PRODUCT",
    links: [
      { label: "Try on a repo", href: "/scan" },
      { label: "How it works", href: "#how" },
      { label: "The memory layers", href: "#memory" },
      { label: "Speed", href: "#speed" },
    ],
  },
  {
    title: "DEVELOPERS",
    links: [
      { label: "Install", href: "#install" },
      { label: "GitHub", href: "https://github.com/theanshsonkar/carto" },
      { label: "npm", href: "https://www.npmjs.com/package/carto-md" },
      { label: "ANCI format", href: "#anci" },
    ],
  },
  {
    title: "TOOLS IT WIRES INTO",
    links: [
      { label: "Cursor", href: "#" },
      { label: "Claude Code", href: "#" },
      { label: "Codex", href: "#" },
      { label: "Zed / VS Code", href: "#" },
    ],
  },
  {
    title: "LEGAL",
    links: [
      { label: "MIT License", href: "#" },
      { label: "Privacy", href: "#" },
      { label: "Security", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mt-auto bg-ink text-paper">
      <div className="shell grid gap-12 py-16 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="max-w-xs">
          <div className="flex items-center gap-2.5">
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              aria-hidden
            >
              <rect
                x="3"
                y="3"
                width="18"
                height="18"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="8" cy="8" r="1.4" fill="currentColor" />
              <circle cx="16" cy="8" r="1.4" fill="currentColor" />
              <circle cx="12" cy="16" r="1.4" fill="currentColor" />
              <path
                d="M8 8L16 8M8 8L12 16M16 8L12 16"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
            <span className="font-display text-[1.05rem] font-medium tracking-tight">
              carto
            </span>
          </div>
          <p className="mt-5 text-sm leading-relaxed text-paper/55">
            The nervous system for AI coding. Every AI tool on your machine
            plugs into the map — and reflexes fire in microseconds, before a
            bad diff hits your screen.
          </p>
        </div>

        {columns.map((col) => (
          <div key={col.title}>
            <h4 className="font-mono text-[0.7rem] tracking-[0.18em] text-paper/40">
              {col.title}
            </h4>
            <ul className="mt-5 space-y-3">
              {col.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-paper/70 transition-colors hover:text-paper"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-paper/10">
        <div className="shell flex flex-col gap-2 py-6 text-[0.78rem] text-paper/40 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-mono">
            © 2026 Carto. MIT. Local by default.
          </span>
          <span className="font-mono tracking-[0.14em]">
            ONE SQLITE FILE · NO NETWORK · NO TELEMETRY
          </span>
        </div>
      </div>
    </footer>
  );
}
