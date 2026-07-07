import { Eyebrow } from "./ui/Eyebrow";
import { Reveal } from "./ui/Reveal";
import { CodeBlock, tok } from "./ui/CodeBlock";

const tools = [
  "Cursor",
  "Claude Code",
  "Codex",
  "Kiro",
  "Claude Desktop",
  "Windsurf",
  "VS Code Copilot",
  "Zed",
  "JetBrains",
];

export function InstallCLI() {
  return (
    <section id="install" className="border-b border-line bg-panel-2/40">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <h2 className="max-w-3xl font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
            <span className="text-route">One command.</span> Every AI tool on your machine gets the map.
          </h2>
          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-2">
            Carto auto-detects every AI tool installed on your machine and
            wires itself in via MCP. Restart the tool. Your AI now knows your
            codebase — and keeps a memory of every decision it makes inside
            it.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-8 md:grid-cols-[1.05fr_1fr]">
          <Reveal>
            <CodeBlock file="terminal" className="h-full">
              <span className={tok.dim}>$ </span>
              <span className={tok.key}>npm</span> install -g{" "}
              <span className={tok.str}>carto-md</span>
              {"\n"}
              <span className={tok.dim}>$ </span>
              <span className={tok.key}>cd</span> your-project
              {"\n"}
              <span className={tok.dim}>$ </span>
              <span className={tok.key}>carto</span> init
              {"\n\n"}
              <span className={tok.dim}>
                {"› parsing 6,358 files ....... done (5.9s)"}
              </span>
              {"\n"}
              <span className={tok.dim}>
                {"› building import graph .... done"}
              </span>
              {"\n"}
              <span className={tok.dim}>
                {"› detecting 86 routes ...... done"}
              </span>
              {"\n"}
              <span className={tok.dim}>
                {"› mining 7 domains ......... done"}
              </span>
              {"\n"}
              <span className={tok.dim}>
                {"› wiring cursor · claude · codex"}
              </span>
              {"\n\n"}
              <span className={tok.route}>
                {"✓ Your AI now sees the map. Restart your tool."}
              </span>
            </CodeBlock>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="flex h-full flex-col border border-line bg-paper p-7">
              <Eyebrow className="mb-5">AUTO-WIRES INTO</Eyebrow>
              <ul className="grid flex-1 grid-cols-2 gap-y-3 gap-x-6">
                {tools.map((t) => (
                  <li
                    key={t}
                    className="flex items-center gap-2 font-mono text-[0.85rem] text-ink"
                  >
                    <span className="text-route">→</span>
                    {t}
                  </li>
                ))}
              </ul>
              <div className="mt-6 border-t border-line pt-5">
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.14em] text-ink-3">
                  Also runs as
                </p>
                <p className="mt-2 text-[0.9rem] text-ink-2">
                  ACP agent (Zed / JetBrains) · MCP middleware · GitHub Action
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
