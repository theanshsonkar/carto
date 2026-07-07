/**
 * Section pacing label. Renders `) SECTION NAME` on the left and `[ N / M ]`
 * on the right, with a border-bottom rule. Placed at the top of every content
 * section — makes the page read like a technical spec.
 */
export function SectionLabel({
  name,
  index,
  total,
}: {
  name: string;
  index: number;
  total: number;
}) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div className="border-b border-line">
      <div className="shell flex h-9 items-center justify-between font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ink-3">
        <span>
          <span className="text-ink-3">&gt;</span>{" "}
          <span className="text-ink-2">{name}</span>
        </span>
        <span>
          [ {pad(index)} / {pad(total)} ]
        </span>
      </div>
    </div>
  );
}
