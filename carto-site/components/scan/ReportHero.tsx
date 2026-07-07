"use client";

import Link from "next/link";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Frame } from "@/components/ui/Frame";
import type { Report } from "./report-data";
import { aiVerdict } from "./report-data";
import { DomainMap } from "./panels/DomainMap";

/**
 * The anchoring visual for the whole report. Replaces the previous
 * understated header. Two-column: left is repo identity + verdict + three
 * punchy stat callouts + CTA row; right is the DomainMap inside a Frame so
 * the map inherits the drafting-paper vocabulary.
 *
 * The verdict headline is derived from the risk score and the top file's
 * blast radius — so different repos produce different lines rather than a
 * single generic slogan.
 */
export function ReportHero({
  report,
  onReset,
}: {
  report: Report;
  onReset: () => void;
}) {
  const topFile = report.blast[0];
  const topFileName = topFile.file.split("/").slice(-2).join("/");
  const primaryDomain = report.domains
    .slice()
    .sort((a, b) => b.files - a.files)[0];
  const worst = report.risk.categories.find((c) => c.weak);
  const headline = buildHeadline(report);

  return (
    <section className="relative border-b border-line bg-panel/40 bp-grid">
      <div className="shell-wide py-14 md:py-20">
        <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:gap-10">
          {/* ---- LEFT: identity + verdict + callouts + CTA ---- */}
          <div className="flex flex-col justify-between gap-10">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <Eyebrow>CARTO REPORT</Eyebrow>
                <span className="font-mono text-[0.7rem] text-ink-3">
                  indexed {report.repo.indexedAt} · {report.repo.primaryLang}
                </span>
              </div>

              <h1 className="mt-5 break-words font-mono text-[1.6rem] font-medium leading-[1.1] text-ink md:text-[2rem]">
                {report.repo.name}
              </h1>

              <Link
                href={`https://${report.repo.url}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-flex font-mono text-[0.78rem] text-route hover:underline"
              >
                {report.repo.url} ↗
              </Link>

              {/* the verdict — data-driven headline */}
              <p className="mt-8 max-w-lg font-display text-3xl font-medium leading-[1.1] tracking-tight text-ink md:text-[2.4rem]">
                {headline.headline}
              </p>
              <p className="mt-4 max-w-md text-[0.95rem] leading-relaxed text-ink-2">
                {headline.subline}
              </p>
            </div>

            {/* three punchy callouts, stacked */}
            <div className="grid gap-px border border-line bg-line sm:grid-cols-3">
              <HeroStat
                label="RISKIEST FILE · CAN BREAK"
                value={topFile.total}
                tone="signal"
                caption={`others, via ${topFileName}`}
              />
              <HeroStat
                label={`WEAKEST SPOT · ${worst?.label ?? "RISK"}`}
                value={worst?.score ?? report.risk.overall}
                tone="ink"
                caption={worst?.note ?? report.risk.label}
                unit="/100"
              />
              <HeroStat
                label="BIGGEST PART"
                value={primaryDomain?.name ?? "—"}
                tone="route"
                caption={`${primaryDomain?.files.toLocaleString() ?? 0} files · ${primaryDomain?.stability ?? "?"}`}
                small
              />
            </div>

            {/* CTA row */}
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="#install"
                className="inline-flex h-11 items-center gap-2 border border-ink bg-ink px-5 font-mono text-[0.85rem] text-paper transition-colors hover:bg-transparent hover:text-ink"
              >
                run this on your repo →
              </Link>
              <button
                onClick={onReset}
                className="inline-flex h-11 items-center gap-2 border border-line bg-paper px-5 font-mono text-[0.85rem] text-ink transition-colors hover:border-ink"
              >
                ← scan another
              </button>
              <a
                href="#ai-view"
                className="ml-auto font-mono text-[0.75rem] text-ink-3 hover:text-ink"
              >
                see what your AI sees ↓
              </a>
            </div>
          </div>

          {/* ---- RIGHT: the map ---- */}
          <div className="relative">
            <Frame className="bg-paper p-3 md:p-4">
              <div className="mb-3 flex items-center justify-between px-1">
                <Eyebrow>THE MAP · HOW YOUR CODE CLUSTERS</Eyebrow>
                <span className="font-mono text-[0.7rem] text-ink-3">
                  fig 01
                </span>
              </div>
              <DomainMap
                domains={report.domains}
                crossDomain={report.crossDomain}
              />
            </Frame>
            <p className="mt-3 max-w-md font-mono text-[0.7rem] text-ink-3">
              Each blob is a group of related files Carto found on its own. The
              red dashes are tangled connections — parts of the app reaching into
              each other in ways nobody planned, and the AI can&apos;t see.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroStat({
  label,
  value,
  tone = "ink",
  caption,
  unit,
  small = false,
}: {
  label: string;
  value: string | number;
  tone?: "ink" | "signal" | "route" | "safe";
  caption: string;
  unit?: string;
  small?: boolean;
}) {
  const toneClass = {
    ink: "text-ink",
    signal: "text-signal",
    route: "text-route",
    safe: "text-safe",
  }[tone];

  return (
    <div className="bg-paper p-5">
      <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-ink-3">
        {label}
      </p>
      <p
        className={`mt-3 font-display font-semibold leading-none ${toneClass} ${
          small ? "text-[1.9rem]" : "text-[2.5rem]"
        }`}
      >
        {value}
        {unit && (
          <span className="ml-1 text-base text-ink-3">{unit}</span>
        )}
      </p>
      <p className="mt-3 line-clamp-2 font-mono text-[0.7rem] text-ink-3">
        {caption}
      </p>
    </div>
  );
}

/**
 * Compose a two-line verdict from the numbers. AI-native framing: the
 * question isn't "is this code clean" but "can the AI keep building here."
 * Deliberately templated — consistent shape, but the specific verbs and
 * numbers shift by the shape of the data. Kept complementary to (not a
 * duplicate of) the AI-maintainability panel's headline.
 */
function buildHeadline(report: Report): {
  headline: string;
  subline: string;
} {
  const v = aiVerdict(report);

  // Headline: the AI-native framing, keyed off the maintainability grade.
  let headline: string;
  if (v.grade === "fragile") {
    headline = `Your AI can't safely build here anymore.`;
  } else if (v.grade === "at risk") {
    headline = `Every AI edit here is a coin flip.`;
  } else if (v.grade === "holding") {
    headline = `The AI can build — until it hits the wrong file.`;
  } else {
    headline = `Solid ground for your AI. Keep it that way.`;
  }

  // Subline: contextual, always cites specific numbers.
  const subline = [
    `AI-maintainability ${v.score}/100 — ${v.grade}.`,
    `${report.stats.files.toLocaleString()} files, ${report.stats.domains} domains,`,
    `${report.stats.edges.toLocaleString()} imports resolved.`,
    `Projected: it breaks something unseen ${v.breakRate}.`,
  ].join(" ");

  return { headline, subline };
}
