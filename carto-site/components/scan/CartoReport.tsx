"use client";

import Link from "next/link";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { StatCell } from "@/components/ui/StatCell";
import { Nav } from "@/components/Nav";
import { AnnounceBar } from "@/components/AnnounceBar";
import { Footer } from "@/components/Footer";
import type { Report } from "./report-data";
import { ReportHero } from "./ReportHero";
import { ShareCard } from "./ShareCard";
import { AIMaintainabilityPanel } from "./panels/AIMaintainabilityPanel";
import { RiskScoreCard } from "./panels/RiskScoreCard";
import { HighImpactTable } from "./panels/HighImpactTable";
import { DomainsGrid } from "./panels/DomainsGrid";
import { HotspotsPanel } from "./panels/HotspotsPanel";
import { BlastRadiusExplorer } from "./panels/BlastRadiusExplorer";
import { AIViewPanel } from "./panels/AIViewPanel";
import { DriftTimeline } from "./panels/DriftTimeline";
import { CrossDomainPanel } from "./panels/CrossDomainPanel";
import { RoutesModelsPanel } from "./panels/RoutesModelsPanel";
import { InvariantsConventionsPanel } from "./panels/InvariantsConventionsPanel";
import { DecisionLogPanel } from "./panels/DecisionLogPanel";
import { DeadCodePanel } from "./panels/DeadCodePanel";

/**
 * The Carto scan report. The visual arc:
 *
 *   1. ReportHero      — verdict + domain map, the "aha" landing
 *   2. Stats ribbon    — the numbers, laid flat
 *   3. Risk + Impact   — the two headline lists
 *   4. Domains + Hot   — clusters and their weight
 *   5. BlastRadius     — one file, its downstream cone
 *   6. AI View         — the pitch: what your AI would see (id="ai-view")
 *   7. Drift + Cross-D — history + boundary breaks
 *   8. Routes + Models — extraction proof
 *   9. Invariants + Dec— the mined brain
 *  10. Dead code       — the surface Carto could quietly clean
 *  11. ShareCard       — the poster to screenshot
 *  12. Install CTA     — how to run it live (id="install")
 */
export function CartoReport({
  report,
  onReset,
}: {
  report: Report;
  onReset: () => void;
}) {
  return (
    <>
      <AnnounceBar />
      <Nav />

      {/* 1. HERO — verdict + map */}
      <ReportHero report={report} onReset={onReset} />

      {/* 1b. THE VERDICT — AI-maintainability lead panel (the differentiator) */}
      <section className="border-b border-line bg-paper">
        <div className="shell-wide py-8">
          <AIMaintainabilityPanel report={report} />
        </div>
      </section>

      {/* 2. STATS RIBBON — a flat data band under the hero */}
      <section className="border-b border-line bg-panel-2/50">
        <div className="shell-wide">
          <div className="grid grid-cols-2 divide-x divide-line md:grid-cols-6">
            <StatCell
              label="Files"
              value={report.stats.files.toLocaleString()}
              caption="parsed"
            />
            <StatCell
              label="Routes"
              value={report.stats.routes}
              caption="extracted"
            />
            <StatCell
              label="Import edges"
              value={report.stats.edges.toLocaleString()}
              caption="resolved"
            />
            <StatCell
              label="Domains"
              value={report.stats.domains}
              caption="clustered"
            />
            <StatCell
              label="First index"
              value={fmtMs(report.stats.firstIndexMs)}
              caption={`re-index: ${fmtMs(report.stats.reindexMs)}`}
              tone="route"
            />
            <StatCell
              label="DB size"
              value={`${report.stats.dbSizeMb.toFixed(1)} MB`}
              caption="one sqlite file"
            />
          </div>
        </div>
      </section>

      {/* 3–10. PANELS */}
      <main className="flex-1 bg-paper py-10">
        <div className="shell-wide space-y-6">
          {/* divider: everything below is the proof, for whoever wants it */}
          <div className="border-b border-line pb-5">
            <Eyebrow className="mb-2">THE EVIDENCE · UNDER THE HOOD</Eyebrow>
            <p className="max-w-2xl text-[0.95rem] leading-relaxed text-ink-2">
              That&apos;s the verdict. Everything below is the proof behind it —
              the exact files, connections, and history Carto read to get there.
              Skim it if you&apos;re curious; dig in if you&apos;re the engineer
              who wants receipts.
            </p>
          </div>

          {/* 3. risk + high-impact */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <RiskScoreCard risk={report.risk} />
            <HighImpactTable rows={report.highImpact} />
          </div>

          {/* 4. domains + hotspots */}
          <div className="grid gap-6 lg:grid-cols-2">
            <DomainsGrid domains={report.domains} />
            <HotspotsPanel rows={report.hotspots} />
          </div>

          {/* 5. blast (full width) */}
          <BlastRadiusExplorer entry={report.blast[0]} />

          {/* 6. AI View — the pitch, made literal (anchor target) */}
          <section id="ai-view" className="scroll-mt-20">
            <AIViewPanel report={report} />
          </section>

          {/* 7. drift + cross-domain */}
          <div className="grid gap-6 lg:grid-cols-2">
            <DriftTimeline events={report.drift} />
            <CrossDomainPanel violations={report.crossDomain} />
          </div>

          {/* 8. routes + models */}
          <RoutesModelsPanel routes={report.routes} models={report.models} />

          {/* 9. invariants/conventions + decisions */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <InvariantsConventionsPanel
              invariants={report.invariants}
              conventions={report.conventions}
            />
            <DecisionLogPanel decisions={report.decisions} />
          </div>

          {/* 10. dead code */}
          <DeadCodePanel rows={report.deadCode} />
        </div>
      </main>

      {/* 11. SHARE CARD */}
      <ShareCard report={report} />

      {/* 12. INSTALL CTA */}
      <section id="install" className="border-y border-line bp-grid">
        <div className="shell-wide py-16 text-center">
          <Eyebrow className="mb-6">RUN THIS ON YOUR MACHINE</Eyebrow>
          <h2 className="mx-auto max-w-3xl font-display text-3xl font-medium leading-[1.05] tracking-tight text-ink md:text-5xl">
            Real Carto runs locally.
            <br />
            <span className="text-ink-3">
              One SQLite file, no network, no telemetry.
            </span>
          </h2>
          <div className="mx-auto mt-8 inline-flex items-center gap-3 border border-ink bg-panel px-5 py-3 font-mono text-[0.9rem] text-ink">
            <span className="text-ink-3">$</span>
            npm install -g carto-md
          </div>
          <p className="mt-6 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-ink-3">
            Then <span className="text-ink">carto init</span> in your repo.
            Every AI tool on your machine gets the map.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="https://github.com/theanshsonkar/carto"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-2 border border-ink bg-ink px-4 font-mono text-[0.78rem] text-paper transition-colors hover:bg-transparent hover:text-ink"
            >
              github ↗
            </Link>
            <button
              onClick={onReset}
              className="inline-flex h-10 items-center gap-2 border border-line bg-paper px-4 font-mono text-[0.78rem] text-ink transition-colors hover:border-ink"
            >
              ← scan another repo
            </button>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
