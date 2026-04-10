import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { NavBar } from "@/components/landing/NavBar";
import { ScrollReveal } from "@/components/landing/ScrollReveal";
import { SigilLogo } from "@/components/ui/SigilLogo";
import Link from "next/link";
import { ArrowRight, Github } from "lucide-react";

export default function HomePage() {
  return (
    <main className="bg-canvas bg-dot-pattern bg-dot">
      <a
        href="#hero"
        className="sr-only focus:not-sr-only focus:absolute focus:top-14 focus:left-4 focus:z-[60] focus:bg-accent focus:text-white focus:px-4 focus:py-2 focus:rounded-md focus:font-mono focus:text-xs focus:uppercase"
      >
        Skip to content
      </a>

      <NavBar />

      <div id="hero" className="pt-12 sm:pt-12">
        <Hero />
      </div>

      <HowItWorks />

      {/* Closing CTA */}
      <section className="below-fold relative py-24 sm:py-32 lg:py-44 cta-section-glow section-divider-bold">
        <ScrollReveal className="max-w-6xl mx-auto px-4 sm:px-6 text-center">
          <h2 className="font-black text-bright mb-6 tracking-[-0.04em]" style={{ fontSize: "clamp(2rem, 3.5vw + 0.5rem, 3.25rem)" }}>
            Ship your first workflow.
          </h2>
          <p className="text-body/90 text-base sm:text-lg leading-relaxed mb-12 max-w-lg mx-auto">
            Define a graph, run it locally, and stream execution to your terminal. No platform lock-in.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
            <Link
              href="/editor"
              className="inline-flex items-center justify-center gap-2.5 bg-accent hover:bg-accent-hover text-white font-mono text-sm uppercase tracking-wider font-semibold px-9 py-4 min-h-[52px] w-full sm:w-auto rounded-lg transition-all duration-200 cta-glow hover:scale-[1.02] active:scale-[0.98]"
            >
              Build a Workflow
              <ArrowRight size={15} strokeWidth={2.5} />
            </Link>
            <Link
              href="https://github.com/akshatvasisht/sigil"
              target="_blank"
              rel="noopener noreferrer"
              className="view-source-btn inline-flex items-center justify-center gap-2 font-mono text-sm uppercase tracking-wider text-dim hover:text-body border border-white/[0.1] hover:border-white/[0.15] px-8 py-4 min-h-[52px] w-full sm:w-auto rounded-lg transition-all duration-200 hover:bg-white/[0.03]"
            >
              <Github size={13} />
              View Source
            </Link>
          </div>
        </ScrollReveal>
      </section>

      {/* Footer */}
      <footer aria-label="Site footer" className="below-fold relative border-t border-white/[0.06] py-8 sm:py-10">
        {/* Accent gradient at top */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent/15 to-transparent" />
        <ScrollReveal className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 footer-logo">
            <SigilLogo size={14} color="#3f3f46" />
            <span className="font-mono font-semibold text-dim text-sm tracking-tight">sigil</span>
            <span className="hidden sm:inline font-mono text-[10px] text-dim">
              deterministic orchestration for probabilistic agents
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="https://github.com/akshatvasisht/sigil"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-xs text-dim hover:text-body uppercase tracking-wider transition-colors duration-200 min-h-[44px] px-2"
            >
              <Github size={12} />
              GitHub
            </Link>
            <span className="font-mono text-xs text-dim uppercase tracking-wider min-h-[44px] inline-flex items-center">
              MIT
            </span>
          </div>
        </ScrollReveal>
      </footer>
    </main>
  );
}
