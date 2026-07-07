import { Suspense } from "react";
import type { Metadata } from "next";
import { ScanApp } from "@/components/scan/ScanApp";

export const metadata: Metadata = {
  title: "Try Carto on any repo",
  description:
    "Paste a GitHub URL. Carto maps the architecture, scores every file's blast radius, and shows what your AI would see.",
};

export default function ScanPage() {
  return (
    <Suspense fallback={<ScanFallback />}>
      <ScanApp />
    </Suspense>
  );
}

function ScanFallback() {
  return (
    <section className="border-b border-line bp-grid">
      <div className="shell py-24 md:py-32">
        <div className="mx-auto max-w-2xl">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.18em] text-ink-3">
            [ LOADING ]
          </p>
          <h1 className="mt-3 font-display text-4xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
            Warming up the map…
          </h1>
        </div>
      </div>
    </section>
  );
}
