import { Eyebrow } from "./Eyebrow";

/**
 * Dashboard panel: a titled, bordered surface with a header strip that carries
 * an eyebrow label + an optional right-side hint. The report grid stitches
 * panels together with divide-x/divide-y — panels themselves don't carry
 * outer margins, only inner padding.
 */
export function Panel({
  label,
  hint,
  children,
  className = "",
  bodyClassName = "",
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`flex min-h-full flex-col border border-line bg-panel ${className}`}
    >
      <header className="flex items-center justify-between border-b border-line bg-paper px-5 py-3">
        <Eyebrow>{label}</Eyebrow>
        {hint && (
          <span className="font-mono text-[0.7rem] text-ink-3">{hint}</span>
        )}
      </header>
      <div className={`flex-1 p-5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
