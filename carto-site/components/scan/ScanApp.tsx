"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RepoInput } from "./RepoInput";
import { ScanSequence } from "./ScanSequence";
import { CartoReport } from "./CartoReport";
import { buildReport, type Report } from "./report-data";

type Phase = "idle" | "scanning" | "report";

/**
 * Drives the scan flow: idle (paste a repo) → scanning (animated) → report.
 * When the URL includes `?repo=...`, auto-starts the scan.
 */
export function ScanApp() {
  const params = useSearchParams();
  const paramRepo = params.get("repo")?.trim() ?? "";

  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [report, setReport] = useState<Report | null>(null);

  // auto-start from ?repo=
  useEffect(() => {
    if (paramRepo && phase === "idle") {
      run(paramRepo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramRepo]);

  function run(repoUrl: string) {
    setUrl(repoUrl);
    setReport(buildReport(repoUrl));
    setPhase("scanning");
  }

  function reset() {
    setPhase("idle");
    setReport(null);
    setUrl("");
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }

  if (phase === "idle") return <RepoInput onRun={run} />;
  if (phase === "scanning")
    return <ScanSequence url={url} onComplete={() => setPhase("report")} />;
  return report ? <CartoReport report={report} onReset={reset} /> : null;
}
