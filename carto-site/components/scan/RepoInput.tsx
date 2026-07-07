"use client";

import { useState } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Frame } from "@/components/ui/Frame";

const suggestions = [
  { label: "supabase", url: "github.com/supabase/supabase" },
  { label: "next.js", url: "github.com/vercel/next.js" },
  { label: "vscode", url: "github.com/microsoft/vscode" },
  { label: "cal.com", url: "github.com/calcom/cal.com" },
];

export function RepoInput({ onRun }: { onRun: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = url.trim();
    if (!t) {
      setError("Paste a GitHub URL to start");
      return;
    }
    if (!/github\.com|^[\w-]+\/[\w.-]+$/.test(t)) {
      setError("Doesn't look like a GitHub repo");
      return;
    }
    setError(null);
    onRun(t);
  }

  return (
    <section className="border-b border-line bp-grid">
      <div className="shell py-24 md:py-32">
        <div className="mx-auto max-w-2xl">
          <Eyebrow className="mb-7">TRY IT ON A REPO</Eyebrow>
          <h1 className="font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
            Paste a GitHub URL.
            <br />
            <span className="text-ink-3">Get the full map.</span>
          </h1>

          <p className="mt-7 max-w-lg text-lg leading-relaxed text-ink-2">
            Carto will index the repo, build the import graph, extract routes
            and domains, and score every file&apos;s blast radius — right here.
          </p>

          <Frame className="mt-10 bg-panel">
            <form onSubmit={submit} className="p-1">
              <div className="flex items-center gap-3 border-b border-line px-4 py-2">
                <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
                  paste a github url
                </span>
                <span className="ml-auto font-mono text-[0.7rem] text-ink-3">
                  demo · client-side
                </span>
              </div>
              <div className="flex items-stretch">
                <span
                  aria-hidden
                  className="hidden items-center border-r border-line px-3 font-mono text-[0.85rem] text-ink-3 sm:flex"
                >
                  {">"}
                </span>
                <input
                  autoFocus
                  type="text"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="github.com/supabase/supabase"
                  className="min-w-0 flex-1 bg-transparent px-4 py-4 font-mono text-[0.9rem] text-ink placeholder:text-ink-3 focus:outline-none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="submit"
                  className="group inline-flex items-center gap-2 border-l border-ink bg-ink px-6 text-sm font-medium text-paper transition-colors hover:bg-transparent hover:text-ink"
                >
                  Run Carto
                  <span
                    aria-hidden
                    className="transition-transform group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </button>
              </div>
            </form>
          </Frame>

          {error && (
            <p className="mt-3 font-mono text-[0.75rem] text-signal">
              ! {error}
            </p>
          )}

          <div className="mt-8">
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-3">
              Or try one of these
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => onRun(s.url)}
                  className="border border-line bg-paper px-3 py-1.5 font-mono text-[0.8rem] text-ink transition-colors hover:border-ink"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-10 border-t border-line pt-6 font-mono text-[0.72rem] text-ink-3">
            Real Carto runs locally against your checkout. This demo uses
            curated data — same shape, same numbers, so you can see what a
            report looks like.
          </p>
        </div>
      </div>
    </section>
  );
}
