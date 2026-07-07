/**
 * A blueprint frame: a hairline-ruled box with small filled "registration
 * squares" at the four corners — the same marks a printer uses to align a
 * proof. Encloses diagrams and panels.
 *
 * The tick is a 6px solid `route` square, straddling the corner so half sits
 * on the frame edge and half spills onto the page. Reads as a real drafting
 * mark rather than a UI icon.
 */
export function Frame({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative border border-line ${className}`}>
      <Tick className="-left-[3px] -top-[3px]" />
      <Tick className="-right-[3px] -top-[3px]" />
      <Tick className="-left-[3px] -bottom-[3px]" />
      <Tick className="-right-[3px] -bottom-[3px]" />
      {children}
    </div>
  );
}

function Tick({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={`absolute z-10 h-1.5 w-1.5 bg-route ${className}`}
    />
  );
}
