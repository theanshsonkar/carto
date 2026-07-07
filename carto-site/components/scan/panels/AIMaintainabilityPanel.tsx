"use client";

import { Eyebrow } from "@/components/ui/Eyebrow";
import { aiVerdict, type Report, type AiVerdict } from "../report-data";

/**
 * The lead verdict of the report — reframed for the AI-native builder.
 *
 * Not "is this code clean" but the question a vibe coder actually feels:
 * "can my AI keep building on this repo, or has it painted itself into a
 * corner?" Left column is the scorecard (big number + break-rate gauge);
 * right column is the plain-language verdict, the named culprit files, and
 * the detected "AI-slop" signals. Everything is derived from the report
 * (see aiVerdict) — same data, sharper question.
 */
export function AIMaintainabilityPanel({ report }: { report: Report }) {
  const v = aiVerdict(report);
  const tone = gradeTone(v.grade);

  return (
    <section className="border border-ink bg-panel">
      <header className="flex items-center justify-between border-b border-line bg-paper px-5 py-3">
        <Eyebrow>THE VERDICT · CAN YOUR AI KEEP BUILDING ON THIS?</Eyebrow>
        <span className="font-mono text-[0.7rem] text-ink-3">
          AI-maintainability
        </span>
      </header>

      <div className="grid gap-px bg-line md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        {/* ---- LEFT: the scorecard ---- */}
        <div className="flex flex-col justify-between gap-6 bg-panel p-6">
          <div>
            <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-ink-3">
              AI-MAINTAINABILITY SCORE
            </p>
            <div className="mt-2 flex items-end gap-2">
              <span
                className={`font-display font-semibold leading-none ${tone.text} text-[4.5rem]`}
              >
                {v.score}
              </span>
              <span className="mb-2 font-mono text-sm text-ink-3">/ 100</span>
            </div>
            <p
              className={`mt-1 inline-flex items-center gap-2 font-mono text-[0.8rem] uppercase tracking-[0.12em] ${tone.text}`}
            >
              <span
                className={`inline-block h-2 w-2 ${tone.dot}`}
                aria-hidden
              />
              {v.grade}
            </p>

            {/* gauge */}
            <div className="mt-5 h-1.5 w-full overflow-hidden bg-line">
              <div
                className={`h-full ${tone.bar}`}
                style={{ width: `${v.score}%` }}
              />
            </div>
          </div>

          {/* break-rate callout */}
          <div className={`border-l-2 ${tone.border} ${tone.soft} px-4 py-3`}>
            <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-ink-3">
              PROJECTED FAILURE RATE
            </p>
            <p className={`mt-1 font-display text-2xl font-medium ${tone.text}`}>
              {v.breakRate}
            </p>
            <p className="mt-1 text-[0.78rem] leading-snug text-ink-2">
              an AI edit lands on something it can&apos;t see
            </p>
          </div>
        </div>

        {/* ---- RIGHT: verdict + culprits + signals ---- */}
        <div className="flex flex-col gap-6 bg-panel p-6">
          <div>
            <p className="max-w-xl font-display text-2xl font-medium leading-[1.15] tracking-tight text-ink md:text-[1.9rem]">
              {v.headline}
            </p>
            <p className="mt-3 max-w-xl text-[0.92rem] leading-relaxed text-ink-2">
              {v.subline}
            </p>
          </div>

          {/* culprits */}
          {v.culprits.length > 0 && (
            <div>
              <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-ink-3">
                THE FILES HOLDING YOUR REPO HOSTAGE
              </p>
              <ul className="mt-2 divide-y divide-line border border-line">
                {v.culprits.map((c, i) => (
                  <li
                    key={c.path}
                    className="flex items-center gap-3 bg-paper px-3 py-2.5"
                  >
                    <span className="font-mono text-[0.7rem] text-ink-3">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.85rem] font-medium text-ink">
                        {c.path.split("/").pop()}
                      </p>
                      <p className="truncate text-[0.78rem] text-ink-2">
                        {c.why}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[0.66rem] text-ink-3">
                        {c.path}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-display text-lg font-semibold leading-none text-signal">
                        {c.deps}
                      </p>
                      <p className="font-mono text-[0.6rem] uppercase tracking-wide text-ink-3">
                        can break
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* signals */}
          <div>
            <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-ink-3">
              SIGNALS DETECTED
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {v.signals.map((s) => (
                <div
                  key={s.label}
                  className={`flex items-start gap-2.5 border px-3 py-2.5 ${
                    s.bad
                      ? "border-signal-soft bg-signal-soft/40"
                      : "border-safe-soft bg-safe-soft/40"
                  }`}
                >
                  <span
                    className={`mt-0.5 font-mono text-[0.8rem] ${
                      s.bad ? "text-signal" : "text-safe"
                    }`}
                    aria-hidden
                  >
                    {s.bad ? "!" : "✓"}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`font-mono text-[0.78rem] font-medium ${
                        s.bad ? "text-signal" : "text-safe"
                      }`}
                    >
                      {s.label}
                    </p>
                    <p className="mt-0.5 text-[0.76rem] leading-snug text-ink-2">
                      {s.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* the turn: what carto does about it */}
          <div className="border-t border-line pt-4">
            <p className="text-[0.85rem] leading-relaxed text-ink-2">
              <span className="font-medium text-ink">
                This is the report. The product is the fix:
              </span>{" "}
              Carto rides along with your AI, computes this blast radius before
              every edit, and blocks the writes that would break what the model
              can&apos;t see — so the score stops falling.
            </p>
            <a
              href="#ai-view"
              className="mt-3 inline-flex font-mono text-[0.75rem] text-route hover:underline"
            >
              see how it stops the bad edit ↓
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function gradeTone(grade: AiVerdict["grade"]): {
  text: string;
  bar: string;
  dot: string;
  border: string;
  soft: string;
} {
  switch (grade) {
    case "solid":
      return {
        text: "text-safe",
        bar: "bg-safe",
        dot: "bg-safe",
        border: "border-safe",
        soft: "bg-safe-soft/40",
      };
    case "holding":
      return {
        text: "text-ink",
        bar: "bg-ink",
        dot: "bg-ink",
        border: "border-ink",
        soft: "bg-panel-2",
      };
    case "at risk":
    case "fragile":
    default:
      return {
        text: "text-signal",
        bar: "bg-signal",
        dot: "bg-signal",
        border: "border-signal",
        soft: "bg-signal-soft/40",
      };
  }
}
