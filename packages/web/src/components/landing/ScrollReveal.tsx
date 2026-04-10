"use client";

import { useEffect, useRef, useState } from "react";

interface ScrollRevealProps {
  children: React.ReactNode;
  className?: string;
  /** Additional delay in ms before reveal triggers */
  delay?: number;
  /** Use stagger variant (animates children sequentially) */
  stagger?: boolean;
}

/**
 * Wraps children in a scroll-triggered fade+slide-up reveal.
 * Uses IntersectionObserver for zero-JS-polling performance.
 * Respects prefers-reduced-motion via CSS (see globals.css).
 */
export function ScrollReveal({ children, className = "", delay = 0, stagger = false }: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let delayTimer: ReturnType<typeof setTimeout> | undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          if (delay > 0) {
            delayTimer = setTimeout(() => setIsVisible(true), delay);
          } else {
            setIsVisible(true);
          }
          observer.unobserve(el);
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );

    observer.observe(el);
    return () => {
      if (delayTimer) clearTimeout(delayTimer);
      observer.disconnect();
    };
  }, [delay]);

  const baseClass = stagger ? "scroll-reveal-stagger" : "scroll-reveal";

  return (
    <div
      ref={ref}
      className={`${baseClass} ${isVisible ? "is-visible" : ""} ${className}`}
      style={delay > 0 ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
