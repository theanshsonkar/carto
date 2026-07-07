import Link from "next/link";

type Variant = "solid" | "outline";

const styles: Record<Variant, string> = {
  solid:
    "bg-ink text-paper border border-ink hover:bg-transparent hover:text-ink",
  outline:
    "bg-transparent text-ink border border-line hover:border-ink hover:bg-ink/[0.03]",
};

/**
 * Square-cornered, monospace-flavored button. No rounded corners — this is a
 * blueprint, not a consumer app.
 */
export function Button({
  href,
  children,
  variant = "solid",
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  variant?: Variant;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`group inline-flex h-12 items-center gap-2.5 px-6 text-sm font-medium transition-colors duration-200 ${styles[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
