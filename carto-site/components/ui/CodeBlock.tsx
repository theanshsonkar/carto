/**
 * Light blueprint code block — bordered panel, filename bar, mono body.
 */
export function CodeBlock({
  file,
  children,
  className = "",
}: {
  file: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border border-line bg-panel ${className}`}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-mono text-[0.7rem] text-ink-3">{file}</span>
        <span aria-hidden className="font-mono text-[0.7rem] text-ink-3">
          copy
        </span>
      </div>
      <pre className="overflow-x-auto px-3.5 py-3.5 font-mono text-[0.78rem] leading-relaxed text-ink">
        {children}
      </pre>
    </div>
  );
}

/* token helpers for light-theme code */
export const tok = {
  key: "text-signal",
  str: "text-ink-2",
  dim: "text-ink-3",
  route: "text-route",
};
