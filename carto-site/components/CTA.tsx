"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Reveal } from "./ui/Reveal";

/**
 * Final call-to-action — the paste box repeats, because the pitch is: try
 * it right now, on the site. A giant `carto.` wordmark in tinted route blue
 * sits behind the CTA as a single, deliberate typographic drama moment —
 * the only place on the site where display type is allowed to be decorative.
 */
export function CTA() {
  const router = useRouter();
  const [url, setUrl] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    router.push(
      trimmed ? `/scan?repo=${encodeURIComponent(trimmed)}` : "/scan",
    );
  }

  return (
    <section className="relative overflow-hidden border-b border-line bp-grid">
      {/* the wordmark — enormous, tinted, aria-hidden pure decoration */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -bottom-8 flex items-end justify-center leading-[0.8]"
      >
        <span
          className="select-none font-display font-semibold tracking-[-0.06em] text-route/[0.08]"
          style={{ fontSize: "clamp(10rem, 32vw, 28rem)" }}
        >
          carto.
        </span>
      </div>

      <div className="shell relative py-24 text-center md:py-36">
        <Reveal>
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ink-3">
            [ SEE YOUR OWN REPO ]
          </p>
          <h2 className="mx-auto mt-6 max-w-4xl font-display text-5xl font-medium leading-[1.02] tracking-tight text-ink md:text-7xl">
            Paste a repo.{" "}
            <span className="relative whitespace-nowrap">
              See the map
              <span
                aria-hidden
                className="absolute -bottom-1 left-0 h-[3px] w-full bg-route"
              />
            </span>
            .
          </h2>
          <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-ink-2">
            Try it on any public GitHub repo. Carto maps its architecture,
            scores its risk, and shows every file&apos;s blast radius — right
            here, in your browser. No signup.
          </p>

          <form
            onSubmit={submit}
            className="mx-auto mt-12 flex w-full max-w-2xl border border-ink bg-panel shadow-[0_1px_0_0_var(--color-line-2)] focus-within:border-route"
          >
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="github.com/vercel/next.js"
              className="min-w-0 flex-1 bg-transparent px-6 py-5 font-mono text-base text-ink placeholder:text-ink-3 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="group inline-flex items-center gap-2 border-l border-route bg-route px-7 text-sm font-medium text-paper transition-colors hover:bg-ink hover:border-ink"
            >
              Run Carto
              <span
                aria-hidden
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </button>
          </form>

          <div className="mx-auto mt-8 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-ink-3">
            <span>Free · MIT</span>
            <span className="text-line">·</span>
            <span>No signup</span>
            <span className="text-line">·</span>
            <span>Nothing installed</span>
            <span className="text-line">·</span>
            <span>
              Or locally · <span className="text-ink">npm i -g carto-md</span>
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
