import Link from "next/link";
import { Logo } from "./ui/Logo";
import { Button } from "./ui/Button";

const links = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how" },
  { label: "Try it", href: "/scan" },
  { label: "Install", href: "#install" },
  { label: "GitHub", href: "https://github.com/theanshsonkar/carto" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-paper/80 backdrop-blur-md">
      <div className="shell flex h-16 items-center justify-between">
        <Logo />

        <nav className="hidden items-center gap-9 md:flex">
          {links.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="text-sm text-ink-2 transition-colors hover:text-ink"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-5">
          <Link
            href="https://www.npmjs.com/package/carto-md"
            className="hidden font-mono text-[0.78rem] text-ink-2 transition-colors hover:text-ink sm:block"
          >
            npm i -g carto-md
          </Link>
          <Button href="/scan" className="h-10 px-5">
            Try on a repo
          </Button>
        </div>
      </div>
    </header>
  );
}
