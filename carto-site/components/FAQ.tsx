import { Reveal } from "./ui/Reveal";

/**
 * FAQ — the credibility gap fillers. Uses native <details>/<summary> so it
 * works without a client hook and stays crawlable/accessible. Answers are
 * lifted from the README so nothing here contradicts the actual behaviour.
 *
 * A landing page for a global npm install has to answer these before the
 * developer will run `npm i -g anything`. Especially "does it phone home"
 * and "is it locked to a language".
 */

const questions = [
  {
    q: "Does Carto send my code anywhere?",
    a: "No. Everything is one SQLite file on disk. No cloud, no telemetry, no phone-home. You can prove it — run lsof against the carto process while it works.",
  },
  {
    q: "Which languages are supported?",
    a: "JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin, C, C++, C#, Ruby, PHP, Swift, Dart, R, and Prisma. Import graph + symbols work on all of them. Route + model extraction covers ~20 frameworks (Next.js, Express, tRPC, FastAPI, Django, Gin, Rails, Spring, ASP.NET, and more).",
  },
  {
    q: "How does the memory work across chat sessions?",
    a: "Every diff Carto validates and every architectural decision your AI makes gets written to .carto/carto.db. Any tool that speaks Carto's MCP can call did_we_discuss_this() and get the prior verdict back — same repo, different chat, different AI, six weeks later.",
  },
  {
    q: "Which AI tools does it work with?",
    a: "Cursor, Claude Code, Codex, Kiro, Claude Desktop, Windsurf, VS Code Copilot, Zed, and JetBrains. carto init auto-detects every one it finds on your machine and wires itself in via MCP. If yours isn't detected, one JSON line in that tool's config file adds it.",
  },
  {
    q: "What does it cost?",
    a: "Nothing. MIT license, free forever. There is no hosted tier, no paid plan, no team seats. If your organisation needs SLAs or committed support, that's a separate conversation — but the tool itself is free.",
  },
  {
    q: "How fast is it, really?",
    a: "On a 7,000-file repo (VS Code): validate_diff runs at p50 84 µs and p99 489 µs. get_blast_radius runs at p50 2.7 µs — that's 10.7× faster than the SQLite path it replaces. First index of supabase (6,358 files): 5.9 seconds. Re-index: under 1 second.",
  },
  {
    q: "What about monorepos and multi-repo orgs?",
    a: "carto org lets you register a group of repos under one org and builds a service graph across them. npm, pypi, go-mod, and maven edges are all resolved. Cross-repo blast radius, org-wide domain map, and boundary-violation detection all work.",
  },
];

export function FAQ() {
  return (
    <section id="faq" className="border-b border-line">
      <div className="shell py-20 md:py-28">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-[1fr_1.35fr] md:gap-16">
            {/* left rail — the section identity + still-something-on-your-mind note */}
            <div>
              <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ink-3">
                [ FREQUENTLY ASKED ]
              </p>
              <h2 className="mt-6 font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-5xl">
                The fine print,{" "}
                <span className="text-route">in plain English.</span>
              </h2>
              <p className="mt-6 max-w-sm text-[0.95rem] leading-relaxed text-ink-2">
                Nothing here contradicts the code. If an answer is wrong, the
                behaviour is a bug — please open an issue.
              </p>
              <div className="mt-8 border-t border-line pt-6">
                <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
                  STILL SOMETHING ON YOUR MIND?
                </p>
                <div className="mt-3 flex flex-wrap gap-4 text-[0.9rem]">
                  <a
                    href="https://github.com/theanshsonkar/carto"
                    className="text-ink underline decoration-line hover:decoration-ink"
                  >
                    Read the docs
                  </a>
                  <span className="text-ink-3">·</span>
                  <a
                    href="https://github.com/theanshsonkar/carto/issues"
                    className="text-ink underline decoration-line hover:decoration-ink"
                  >
                    File an issue
                  </a>
                </div>
              </div>
            </div>

            {/* right — the accordion */}
            <div className="border-t border-line">
              {questions.map((item, i) => (
                <details
                  key={item.q}
                  className="group border-b border-line"
                  {...(i === 0 ? { open: true } : {})}
                >
                  <summary className="flex cursor-pointer list-none items-center gap-4 py-5 pr-2 text-left transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
                    <span className="font-mono text-[0.72rem] text-ink-3">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="flex-1 text-[1rem] font-medium text-ink md:text-[1.05rem]">
                      {item.q}
                    </span>
                    <span
                      aria-hidden
                      className="font-mono text-lg text-ink-3 transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <div className="pb-6 pl-9 pr-6 text-[0.95rem] leading-relaxed text-ink-2">
                    {item.a}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
