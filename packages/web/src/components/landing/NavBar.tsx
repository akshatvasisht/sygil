"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Github, BookOpen } from "lucide-react";
import Link from "next/link";
import { SigilLogo } from "@/components/ui/SigilLogo";

/**
 * Fixed navigation bar that solidifies its backdrop on scroll.
 * Transitions from transparent to opaque as user scrolls past the hero.
 */
export function NavBar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 48);
    };
    // Check initial state
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      aria-label="Main navigation"
      className={`nav-bar fixed top-0 left-0 right-0 z-50 border-b border-white/[0.06] bg-canvas/80 transition-[backdrop-filter] duration-300 ${scrolled ? "nav-scrolled backdrop-blur-xl" : "backdrop-blur-none"}`}
    >
      {/* Subtle accent gradient at bottom of nav */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent/10 to-transparent" />
      <div className="max-w-6xl mx-auto px-6 h-12 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="logo-mark inline-flex">
            <SigilLogo size={18} color="#71717a" />
          </span>
          <span className="font-mono font-semibold text-bright text-sm tracking-tight">
            sigil
          </span>
          <span className="version-badge font-mono text-[10px] text-dim border border-white/[0.08] px-1.5 py-0.5 rounded leading-none hidden sm:inline">
            v0.1
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Link
            href="https://github.com/akshatvasisht/sigil"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link hidden sm:inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-dim hover:text-body transition-colors duration-200 px-3 min-h-[44px] rounded-md hover:bg-white/[0.03]"
          >
            <Github size={11} />
            GitHub
          </Link>
          <Link
            href="https://github.com/akshatvasisht/sigil#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link hidden sm:inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-dim hover:text-body transition-colors duration-200 px-3 min-h-[44px] rounded-md hover:bg-white/[0.03]"
          >
            <BookOpen size={11} />
            Docs
          </Link>
          <Link
            href="/editor"
            className="cta-editor nav-cta-glow inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider bg-accent hover:bg-accent-hover text-white px-4 min-h-[44px] rounded-md hover:shadow-[0_0_16px_rgba(255,92,0,0.2)]"
          >
            Editor
            <ArrowRight size={11} strokeWidth={2.5} />
          </Link>
        </div>
      </div>
    </nav>
  );
}
