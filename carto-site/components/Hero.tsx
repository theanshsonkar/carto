"use client";

import Link from "next/link";
import { useState } from "react";
import { Frame } from "./ui/Frame";
import { BrainNeurons } from "./BrainNeurons";
import { ToolMarquee } from "./ui/ToolMarquee";

/**
 * The hero — recomposed in a centered, high-energy layout:
 *
 *   badge → headline → subhead → dual CTA → install command → social proof
 *
 * Then the signature architecture map is lifted out of a flat side-box and
 * staged as a full-bleed near-black showpiece with a blue glow — the "wow"
 * moment, the payoff the visitor is about to get for their own repo.
 */
export function Hero() {
  const [copied, setCopied] = useState(false);

  function copyInstall() {
    navigator.clipboard?.writeText("npm i -g carto-md").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <section className="relative overflow-hidden border-b border-line">
      {/* faint blueprint wash behind the centered hero */}
      <div
        aria-hidden
        className="bp-grid pointer-events-none absolute inset-0 opacity-[0.5]"
      />

      <div className="shell relative flex flex-col items-center py-20 text-center md:py-28">
        {/* ---- badge ---- */}
        <Link
          href="/scan"
          className="group inline-flex items-center gap-2.5 border border-line bg-panel px-3 py-1.5 font-mono text-[0.72rem] tracking-[0.02em] text-ink-2 transition-colors hover:border-route hover:text-ink"
        >
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 bg-route" aria-hidden />
            <span className="uppercase tracking-[0.16em] text-route">New</span>
          </span>
          <span className="text-ink-3">·</span>
          Try it on any public repo in seconds
          <span
            aria-hidden
            className="transition-transform group-hover:translate-x-0.5"
          >
            →
          </span>
        </Link>

        {/* ---- headline ---- */}
        <h1 className="mt-8 max-w-4xl font-display font-medium text-ink [font-size:var(--text-display)] [letter-spacing:var(--text-display--letter-spacing)] [line-height:var(--text-display--line-height)]">
          Give your AI a
          <br />
          <span className="text-route">nervous system.</span>
        </h1>

        {/* ---- subhead ---- */}
        <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-2">
          Carto wires into every AI tool on your machine and gives it reflexes
          — it feels what a change will break and pulls back before the bad diff
          ever reaches you.
        </p>

        {/* ---- dual CTA ---- */}
        <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/scan"
            className="group inline-flex h-12 items-center justify-center gap-2.5 border border-route bg-route px-7 text-sm font-medium text-paper transition-colors hover:bg-route-strong hover:border-route-strong"
          >
            Scan a repo
            <span
              aria-hidden
              className="transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </Link>
          <Link
            href="https://github.com/theanshsonkar/carto"
            className="inline-flex h-12 items-center justify-center gap-2.5 border border-ink bg-transparent px-7 text-sm font-medium text-ink transition-colors hover:bg-ink hover:text-paper"
          >
            View on GitHub
          </Link>
        </div>

        {/* ---- install command ---- */}
        <div className="mt-6 inline-flex items-stretch border border-line bg-panel font-mono text-[0.85rem]">
          <span
            aria-hidden
            className="flex items-center border-r border-line px-3 text-ink-3"
          >
            $
          </span>
          <span className="flex items-center px-4 py-2.5 text-ink">
            npm i -g carto-md
          </span>
          <button
            type="button"
            onClick={copyInstall}
            aria-label="Copy install command"
            className="flex items-center border-l border-line px-3 text-ink-3 transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>

        <p className="mt-5 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-ink-3">
          Free · MIT · One SQLite file · No cloud
        </p>

        {/* compatibility row — kept inside the hero cluster, like
            supermemory's logo strip sitting directly under the CTA */}
        <div className="mt-2 w-full">
          <ToolMarquee />
        </div>
      </div>

      {/* ---- the figure — the nervous system, drawn ----
           A brain threaded with a neuron network sits on the paper as the
           payoff for the headline. It stays on the light surface and inside
           the page rhythm, so it reads as a deliberate figure rather than a
           big black image you scroll into. */}
      <div className="relative border-t border-line">
        {/* faint blueprint grid + a soft blue focus pool behind the brain */}
        <div
          aria-hidden
          className="bp-grid pointer-events-none absolute inset-0 opacity-[0.5]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-[360px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70 blur-3xl"
          style={{
            background:
              "radial-gradient(closest-side, var(--color-route-soft), transparent)",
          }}
        />

        <div className="shell relative flex flex-col items-center py-14 md:py-16">
          <div className="mb-5 flex w-full max-w-xl items-center justify-between px-1">
            <span className="eyebrow inline-flex items-center gap-2">
              <span className="text-ink-3" aria-hidden>
                [
              </span>
              FIG 01 · THE NERVOUS SYSTEM
              <span className="text-ink-3" aria-hidden>
                ]
              </span>
            </span>
            <span className="font-mono text-[0.7rem] text-ink-3">
              one file · what it touches
            </span>
          </div>

          <Frame className="w-full max-w-xl bg-panel p-4">
            <BrainNeurons />
          </Frame>

          <p className="mt-6 max-w-md text-center text-sm leading-relaxed text-ink-2">
            Carto feels every connection. Touch one file and it shows exactly
            what else moves — <span className="text-ink">before</span> the
            change ships.
          </p>
        </div>
      </div>

    </section>
  );
}
