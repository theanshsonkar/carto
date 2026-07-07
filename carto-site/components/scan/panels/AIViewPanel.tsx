import { Panel } from "@/components/ui/Panel";
import type { Report } from "../report-data";

/**
 * AI View — the pitch, made literal. Shows a fake Claude Code interaction:
 * the AI is about to write a diff on the repo's top-blast file, but first it
 * calls Carto's `validate_diff` MCP tool. Carto responds with the risk
 * breakdown. The AI reads the response and revises before ever showing the
 * user the bad diff.
 *
 * Two columns: the CALL (what the AI sends) on the left, the RESPONSE (what
 * Carto returns) on the right. Night terminal palette so it visually reads
 * as "code that ran," distinct from the paper panels around it. A narrative
 * line above and a takeaway strip below sell the payoff in plain language.
 */
export function AIViewPanel({ report }: { report: Report }) {
  const target = report.blast[0];
  const overRadius = target.total;
  const filename = target.file.split("/").pop() ?? target.file;

  const call = [
    `{`,
    `  "tool": "validate_diff",`,
    `  "arguments": {`,
    `    "diff": [`,
    `      {`,
    `        "path": "${target.file}",`,
    `        "hunks": 3,`,
    `        "additions": 41,`,
    `        "deletions": 12`,
    `      }`,
    `    ],`,
    `    "risk_threshold": "MEDIUM"`,
    `  }`,
    `}`,
  ];

  const violation = report.crossDomain[0];
  const violationLine = violation
    ? `    "${violation.kind}: ${violation.fromDomain} → ${violation.toDomain}"`
    : `    "high_blast: ${overRadius} transitive dependents"`;

  const response = [
    `{`,
    `  "risk": "HIGH",`,
    `  "elapsed_ms": 0.084,`,
    `  "violations": [`,
    violationLine + ",",
    `    "high_blast: ${overRadius} transitive dependents (threshold: 50)"`,
    `  ],`,
    `  "blast_radius": ${overRadius},`,
    `  "suggestion":`,
    `    "split into 3 smaller commits;`,
    `     touch ${target.direct} files first, then the rest"`,
    `}`,
  ];

  return (
    <Panel
      label="AI VIEW · WHAT YOUR CODING AGENT SEES"
      hint="MCP call · validate_diff"
    >
      {/* narrative preamble */}
      <p className="mb-5 max-w-3xl text-[0.95rem] leading-relaxed text-ink-2">
        Your AI is about to write a diff on{" "}
        <span className="font-mono text-signal">{filename}</span>. Before
        showing it to you, it asks Carto whether the change is safe. Carto
        answers in{" "}
        <span className="font-mono text-route">84 microseconds</span> — with
        the full blast radius, the violations, and a suggested fix.
      </p>

      {/* the two-column terminal blocks */}
      <div className="grid gap-4 lg:grid-cols-2">
        <TerminalBlock
          arrow="→"
          arrowColor="text-night-route"
          label="AI → CARTO"
          host="claude-code"
          command="tools/call"
          lines={call}
          side="call"
        />
        <TerminalBlock
          arrow="←"
          arrowColor="text-night-safe"
          label="CARTO → AI"
          host="carto-mcp"
          command="tools/response"
          lines={response}
          side="response"
        />
      </div>

      {/* the payoff */}
      <div className="mt-6 border-l-2 border-route bg-route-soft/40 px-4 py-3">
        <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-route-ink">
          the result
        </p>
        <p className="mt-1.5 text-[0.9rem] leading-relaxed text-ink">
          The AI never shows you the bad diff. It revises the plan, or asks a
          clarifying question first — because it now knows{" "}
          <span className="font-mono text-signal">{overRadius}</span> other
          files depend on the one it was about to edit.
        </p>
      </div>
    </Panel>
  );
}

/**
 * A terminal-style code block sized for the AI View panel. Night background,
 * traffic-light header, a call/response arrow badge, and a line-numbered
 * body. Highlights certain lines depending on side.
 */
function TerminalBlock({
  arrow,
  arrowColor,
  label,
  host,
  command,
  lines,
  side,
}: {
  arrow: string;
  arrowColor: string;
  label: string;
  host: string;
  command: string;
  lines: string[];
  side: "call" | "response";
}) {
  return (
    <div className="overflow-hidden border border-night-line bg-night text-night-text">
      <header className="flex items-center justify-between border-b border-night-line px-3 py-2">
        <div className="flex items-center gap-2.5">
          <span
            className={`font-mono text-[0.72rem] font-medium ${arrowColor}`}
          >
            {arrow} {label}
          </span>
          <span className="font-mono text-[0.68rem] text-night-muted">
            · {host}
          </span>
        </div>
        <span className="font-mono text-[0.68rem] text-night-muted">
          {command}
        </span>
      </header>

      <div className="px-3 py-3 font-mono text-[0.75rem] leading-[1.55]">
        {lines.map((raw, i) => {
          const tone = tokenTone(raw, side);
          return (
            <div key={i} className="flex gap-3">
              <span className="w-4 shrink-0 text-right text-night-muted opacity-60">
                {i + 1}
              </span>
              <span className={tone}>{raw}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Light-touch syntax coloring for the terminal blocks — enough to make the
 * JSON feel alive without pulling in a real highlighter. Rules only, so
 * changing lines above doesn't require re-tokenizing.
 */
function tokenTone(line: string, side: "call" | "response"): string {
  const base = "text-night-text";
  if (side === "response") {
    if (/"risk"\s*:\s*"HIGH"/.test(line)) return "text-signal font-semibold";
    if (/"blast_radius"/.test(line)) return "text-night-route";
    if (/"suggestion"/.test(line)) return "text-night-safe";
    if (/"violations"/.test(line)) return "text-signal";
    if (line.trim().startsWith('"') && line.includes(":")) {
      return "text-night-route";
    }
    if (line.trim().startsWith('"')) return "text-night-safe";
  } else {
    if (/"tool"|"arguments"|"diff"|"risk_threshold"/.test(line)) {
      return "text-night-route";
    }
    if (/validate_diff|MEDIUM|HIGH/.test(line)) {
      return "text-night-safe";
    }
    if (line.trim().startsWith('"')) return "text-night-text";
  }
  return base;
}
