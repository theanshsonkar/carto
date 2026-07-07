"use client";

import { useState } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import type { Report } from "./report-data";

/**
 * A screenshot-optimized card sized to look right when someone snips a
 * rectangle from the page and pastes it into a Slack/Twitter/LinkedIn post.
 *
 * Distinct visual identity — night palette, giant display number, drafting
 * grid, monogram + wordmark in the corner. Doesn't reuse Panel, because a
 * shareable image should not carry chrome that mirrors the surrounding UI;
 * it should look like a poster.
 *
 * A single interaction: "copy share link" writes the /scan?repo=... URL to
 * the clipboard so the person can drop it into a reply and let others see
 * the live report.
 */
export function ShareCard({ report }: { report: Report }) {
  const [copied, setCopied] = useState(false);
  const topFile = report.blast[0];
  const share =
    typeof window !== "undefined"
      ? `${window.location.origin}/scan?repo=${encodeURIComponent(report.repo.url)}`
      : `/scan?repo=${encodeURIComponent(report.repo.url)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(share);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard may be blocked; the URL is still visible in the field
    }
  }

  const displayName = report.repo.name.replace(/^https?:\/\//, "");
  const bareTopFile =
    topFile.file.split("/").slice(-2).join("/") || topFile.file;

  return (
    <section className="border-y border-line bg-panel-2/40">
      <div className="shell-wide py-14 md:py-20">
        {/* section eyebrow — outside the card so the card stays clean for screenshots */}
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            <Eyebrow className="mb-3">SHARE THE MAP</Eyebrow>
            <h2 className="max-w-2xl font-display text-2xl font-medium leading-[1.15] tracking-tight text-ink md:text-4xl">
              Post this. Show your team what their AI is about to walk into.
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={copy}
              className="inline-flex h-10 items-center gap-2 border border-ink bg-ink px-4 font-mono text-[0.78rem] text-paper transition-colors hover:bg-transparent hover:text-ink"
            >
              {copied ? "✓ copied" : "copy share link"}
            </button>
          </div>
        </div>

        {/* the poster — bordered, high-contrast, ready to screenshot */}
        <div className="relative overflow-hidden border border-night-line bg-night bp-grid-dark text-night-text">
          {/* corner registration ticks — same visual vocabulary as Frame,
              recolored for the night surface */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 bg-night-route"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 top-0 h-2 w-2 translate-x-1/2 -translate-y-1/2 bg-night-route"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 h-2 w-2 -translate-x-1/2 translate-y-1/2 bg-night-route"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 translate-x-1/2 translate-y-1/2 bg-night-route"
          />

          {/* card header — wordmark + tag */}
          <div className="flex items-center justify-between border-b border-night-line px-6 py-4">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="grid h-7 w-7 place-items-center border border-night-route font-display text-[0.85rem] font-semibold text-night-route"
              >
                C
              </span>
              <div>
                <p className="font-mono text-[0.72rem] font-medium tracking-[0.12em] text-night-text">
                  CARTO
                </p>
                <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-night-muted">
                  the map for AI coding
                </p>
              </div>
            </div>
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-night-muted">
              [ SCAN REPORT · {report.repo.indexedAt.toUpperCase()} ]
            </p>
          </div>

          {/* card body — the poster */}
          <div className="grid gap-8 px-6 py-10 md:grid-cols-[1.15fr_1fr] md:px-10 md:py-12">
            {/* left: repo + verdict */}
            <div className="flex flex-col justify-between gap-8">
              <div>
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.14em] text-night-muted">
                  REPO
                </p>
                <p className="mt-2 break-words font-mono text-[1rem] text-night-text md:text-[1.15rem]">
                  {displayName}
                </p>
                <p className="mt-1 font-mono text-[0.72rem] text-night-muted">
                  {report.stats.files.toLocaleString()} files ·{" "}
                  {report.stats.domains} domains ·{" "}
                  {report.stats.edges.toLocaleString()} imports
                </p>
              </div>

              <div>
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.14em] text-night-muted">
                  TOP BLAST · TOUCH ONE FILE, MOVE THIS MANY
                </p>
                <p className="mt-3 font-display text-[5.5rem] font-semibold leading-[0.9] tracking-tight text-signal md:text-[7rem]">
                  {topFile.total}
                </p>
                <p className="mt-2 break-all font-mono text-[0.8rem] text-night-text">
                  {bareTopFile}
                </p>
                <p className="mt-1 font-mono text-[0.7rem] text-night-muted">
                  transitive dependents · {topFile.hops} hops
                </p>
              </div>
            </div>

            {/* right: three secondary stats stacked */}
            <div className="flex flex-col gap-4">
              <PosterStat
                label="RISK SCORE · P(NEXT BUG)"
                value={`${report.risk.overall}`}
                unit="/ 100"
                caption={report.risk.label}
              />
              <PosterStat
                label="CROSS-DOMAIN VIOLATIONS"
                value={`${report.crossDomain.length}`}
                caption={
                  report.crossDomain.length === 0
                    ? "all imports respect boundaries"
                    : "boundaries breached"
                }
                tone={report.crossDomain.length === 0 ? "safe" : "signal"}
              />
              <PosterStat
                label="RE-INDEX SPEED"
                value={fmtMs(report.stats.reindexMs)}
                caption={`first: ${fmtMs(report.stats.firstIndexMs)} · one sqlite file`}
                tone="route"
              />
            </div>
          </div>

          {/* card footer — watermark + call */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-night-line px-6 py-4">
            <p className="font-mono text-[0.72rem] text-night-muted">
              run the same map on your repo — free · local · MIT
            </p>
            <p className="font-mono text-[0.75rem] tracking-[0.1em] text-night-route">
              carto-md.com/scan
            </p>
          </div>
        </div>

        <p className="mt-4 font-mono text-[0.7rem] text-ink-3">
          Screenshot the poster or use{" "}
          <span className="text-ink">copy share link</span> — anyone with the
          link sees the same live map.
        </p>
      </div>
    </section>
  );
}

function PosterStat({
  label,
  value,
  unit,
  caption,
  tone = "night",
}: {
  label: string;
  value: string;
  unit?: string;
  caption: string;
  tone?: "night" | "signal" | "safe" | "route";
}) {
  const toneClass = {
    night: "text-night-text",
    signal: "text-signal",
    safe: "text-night-safe",
    route: "text-night-route",
  }[tone];

  return (
    <div className="border border-night-line bg-[#16140f] px-5 py-4">
      <p className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-night-muted">
        {label}
      </p>
      <p className={`mt-2 font-display text-3xl font-semibold leading-none ${toneClass}`}>
        {value}
        {unit && (
          <span className="ml-1 text-lg text-night-muted">{unit}</span>
        )}
      </p>
      <p className="mt-2 font-mono text-[0.72rem] text-night-muted">
        {caption}
      </p>
    </div>
  );
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
