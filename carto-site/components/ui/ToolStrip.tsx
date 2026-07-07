/**
 * ToolStrip — the "auto-wires into" row that grounds Carto's compatibility.
 *
 * Each mark is a simplified, single-color rendering of the tool's brand
 * shape — recognisable at 14px without being a pixel-perfect logo copy.
 * They render in `currentColor` so the whole family reads as one
 * Carto-drawn set instead of a scattered logo dump.
 *
 * 9 tools, in the order Carto auto-detects them.
 */

const SIZE = 15;

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={SIZE}
      height={SIZE}
      fill="none"
      aria-hidden
      className="text-ink-2 shrink-0"
    >
      {children}
    </svg>
  );
}

/* --- CURSOR --- pointer arrow with a subtle inner fill */
const CursorMark = () => (
  <Mono>
    <path
      d="M6 4 L18 12 L12 13 L10 20 Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.15"
    />
  </Mono>
);

/* --- CLAUDE CODE --- Anthropic's asymmetric 4-armed spark */
const ClaudeMark = () => (
  <Mono>
    <path
      d="M12 3 C 13 8, 13 10, 21 12 C 13 14, 13 16, 12 21 C 11 16, 11 14, 3 12 C 11 10, 11 8, 12 3 Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.15"
    />
  </Mono>
);

/* --- CODEX / OPENAI --- rosette of 6 rounded lobes */
const CodexMark = () => (
  <Mono>
    <g stroke="currentColor" strokeWidth="1.3" fill="none">
      {Array.from({ length: 6 }).map((_, i) => {
        const angle = (i / 6) * Math.PI * 2;
        const cx = +(12 + Math.cos(angle) * 4.5).toFixed(3);
        const cy = +(12 + Math.sin(angle) * 4.5).toFixed(3);
        const rot = +((angle * 180) / Math.PI + 90).toFixed(3);
        return (
          <ellipse
            key={i}
            cx={cx}
            cy={cy}
            rx="4"
            ry="1.6"
            transform={`rotate(${rot} ${cx} ${cy})`}
          />
        );
      })}
    </g>
  </Mono>
);

/* --- COPILOT --- two goggle-loops with pupils */
const CopilotMark = () => (
  <Mono>
    <path
      d="M4 12 A4 4 0 0 1 8 8 H16 A4 4 0 0 1 20 12 A4 4 0 0 1 16 16 H8 A4 4 0 0 1 4 12 Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <circle cx="9" cy="12" r="1.5" fill="currentColor" />
    <circle cx="15" cy="12" r="1.5" fill="currentColor" />
  </Mono>
);

/* --- VS CODE --- folded ribbon / chevron */
const VSCodeMark = () => (
  <Mono>
    <path
      d="M17 3 L21 5 V19 L17 21 L8 13 L4 16 V8 L8 11 Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.12"
    />
    <path
      d="M17 3 L8 13 L17 21"
      stroke="currentColor"
      strokeWidth="1.3"
      fill="none"
      strokeLinejoin="round"
    />
  </Mono>
);

/* --- ZED --- chunky Z */
const ZedMark = () => (
  <Mono>
    <path
      d="M4 5 H20 L4 19 H20"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </Mono>
);

/* --- WINDSURF --- triangular sail with a curl */
const WindsurfMark = () => (
  <Mono>
    <path
      d="M5 19 L18 5 L18 19 Z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.15"
    />
    <path
      d="M18 5 C 20 10, 20 14, 18 19"
      stroke="currentColor"
      strokeWidth="1.2"
      fill="none"
    />
  </Mono>
);

/* --- JETBRAINS --- 2×2 grid of squares (the family mark) */
const JetBrainsMark = () => (
  <Mono>
    <g stroke="currentColor" strokeWidth="1.3" fill="none">
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" fill="currentColor" fillOpacity="0.18" />
      <rect x="13" y="13" width="7" height="7" />
    </g>
  </Mono>
);

/* --- KIRO --- two edges meeting to form K */
const KiroMark = () => (
  <Mono>
    <path
      d="M5 4 V20 M5 12 L18 4 M5 12 L18 20"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </Mono>
);

const tools = [
  { name: "Cursor", Mark: CursorMark },
  { name: "Claude Code", Mark: ClaudeMark },
  { name: "Codex", Mark: CodexMark },
  { name: "Copilot", Mark: CopilotMark },
  { name: "VS Code", Mark: VSCodeMark },
  { name: "Zed", Mark: ZedMark },
  { name: "Windsurf", Mark: WindsurfMark },
  { name: "JetBrains", Mark: JetBrainsMark },
  { name: "Kiro", Mark: KiroMark },
];

export function ToolStrip() {
  return (
    <div className="mt-10 border-t border-line pt-6">
      <p className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ink-3">
        Auto-wires into
      </p>
      <ul className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-3 md:grid-cols-5 xl:grid-cols-9">
        {tools.map(({ name, Mark }) => (
          <li
            key={name}
            className="flex items-center gap-2 text-[0.8rem] text-ink-2"
          >
            <Mark />
            <span className="truncate font-mono tracking-tight">{name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
