import { AnnounceBar } from "@/components/AnnounceBar";
import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { StatsBand } from "@/components/StatsBand";
import { WhatCartoShows } from "@/components/WhatCartoShows";
import { HowItWorks } from "@/components/HowItWorks";
import { LegacyVsCarto } from "@/components/LegacyVsCarto";
import { MemoryLayers } from "@/components/MemoryLayers";
import { ReflexArc } from "@/components/ReflexArc";
import { AnchorBlock } from "@/components/AnchorBlock";
import { InstallCLI } from "@/components/InstallCLI";
import { CompareTable } from "@/components/CompareTable";
import { InTheWild } from "@/components/InTheWild";
import { HowFast } from "@/components/HowFast";
import { Testimonials } from "@/components/Testimonials";
import { Positioning } from "@/components/Positioning";
import { FAQ } from "@/components/FAQ";
import { CTA } from "@/components/CTA";
import { Footer } from "@/components/Footer";
import { SectionLabel } from "@/components/ui/SectionLabel";

/*
 * Page rhythm — deliberately alternated so the eye never rests on one tone
 * for two sections in a row:
 *
 *   Hero           paper
 *   StatsBand      NIGHT   ← first rhythm break
 *   WhatCartoShows panel-2
 *   HowItWorks     panel-2 (numbered walk; own visual gravity)
 *   LegacyVsCarto  paper
 *   MemoryLayers   paper
 *   ReflexArc      paper   ← anatomy diagram, no section label (companion to AnchorBlock)
 *   AnchorBlock    ROUTE   ← second rhythm break (blue)
 *   InstallCLI     panel-2
 *   CompareTable   panel-2
 *   InTheWild      paper
 *   HowFast        panel-2
 *   Testimonials   paper
 *   Positioning    panel-2
 *   FAQ            paper
 *   CTA            paper (with giant tinted wordmark)
 *   Footer         NIGHT   ← close
 */

const TOTAL = 12;

export default function Home() {
  return (
    <>
      <AnnounceBar />
      <Nav />
      <main className="flex-1">
        <Hero />

        {/* the numbers — dark rhythm break, no section label on purpose */}
        <StatsBand />

        <SectionLabel name="WHAT CARTO SHOWS" index={1} total={TOTAL} />
        <WhatCartoShows />

        <SectionLabel name="HOW IT WORKS" index={2} total={TOTAL} />
        <HowItWorks />

        <SectionLabel name="A DIFFERENT PRIMITIVE" index={3} total={TOTAL} />
        <LegacyVsCarto />

        <SectionLabel name="FIVE LAYERS · THE MAP OVER TIME" index={4} total={TOTAL} />
        <MemoryLayers />

        {/* the reflex arc — anatomical diagram, no section label */}
        <ReflexArc />

        {/* the anchor — full-bleed blue, no section label */}
        <AnchorBlock />

        <SectionLabel name="ADD IT IN A MINUTE" index={5} total={TOTAL} />
        <InstallCLI />

        <SectionLabel name="HEAD-TO-HEAD" index={6} total={TOTAL} />
        <CompareTable />

        <SectionLabel name="IN THE WILD" index={7} total={TOTAL} />
        <InTheWild />

        <SectionLabel name="SPEED · BENCHMARKS" index={8} total={TOTAL} />
        <HowFast />

        <SectionLabel name="TESTIMONIALS" index={9} total={TOTAL} />
        <Testimonials />

        <SectionLabel name="LICENSE · TRUST" index={10} total={TOTAL} />
        <Positioning />

        <SectionLabel name="FAQ" index={11} total={TOTAL} />
        <FAQ />

        <SectionLabel name="SEE YOUR OWN REPO" index={12} total={TOTAL} />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
