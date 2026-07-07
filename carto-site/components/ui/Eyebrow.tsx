/**
 * The signature label device: [ SECTION NAME ].
 * Monospace, bracketed, uppercase — reads like an engineering spec heading.
 */
export function Eyebrow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`eyebrow inline-flex items-center gap-2 ${className}`}>
      <span className="text-ink-3" aria-hidden>
        [
      </span>
      {children}
      <span className="text-ink-3" aria-hidden>
        ]
      </span>
    </span>
  );
}
