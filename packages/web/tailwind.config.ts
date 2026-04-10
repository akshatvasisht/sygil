import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Zinc-black canvas — cool tint, not flat black, not warm
        canvas: "#09090b",
        surface: "#111113",
        panel: "#18181b",
        border: "#27272a",
        "border-bright": "#3f3f46",
        muted: "#3f3f46",
        subtle: "#52525b",
        dim: "#71717a",
        body: "#a1a1aa",
        bright: "#e4e4e7",
        white: "#fafafa",

        // Primary accent — neon orange
        accent: "#FF5C00",
        "accent-hover": "#FF7A2E",

        // Accent variants
        "accent-dim": "#CC4A00",

        // Semantic
        success: "#34d399",
        error: "#f0553e",
        warning: "#f5a623",
        info: "#818cf8",

        // Semantic accents — design system adapter colors + status
        "accent-blue": "#818cf8",
        "accent-cyan": "#14b8a6",
        "accent-green": "#34d399",
        "accent-amber": "#f5a623",
        "accent-red": "#f0553e",
        "accent-purple": "#c084fc",
      },
      fontFamily: {
        // var(--font-sans) resolves to Inter variable (Geist Sans fallback per brand spec)
        sans: ["var(--font-sans)", "'Geist Sans'", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "'Geist Sans'", "system-ui", "sans-serif"],
        // var(--font-mono) resolves to JetBrains Mono (Geist Mono fallback per brand spec)
        mono: ["var(--font-mono)", "'Geist Mono'", "'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      animation: {
        "slide-up": "slide-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-switch": "fade-switch 0.25s cubic-bezier(0.16, 1, 0.3, 1) both",
        "stream-in": "stream-in 0.3s ease-out both",
        "step-pop": "step-pop 0.3s cubic-bezier(0.16, 1, 0.3, 1) both",
        "reveal-up": "reveal-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "slide-in-right": "slide-in-right 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
        "slide-in-left": "slide-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
      },
      keyframes: {
        "slide-up": {
          from: { opacity: "0", transform: "translateY(28px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-switch": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "stream-in": {
          from: { opacity: "0", transform: "translateX(-8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "step-pop": {
          from: { opacity: "0", transform: "translateY(4px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "reveal-up": {
          from: { opacity: "0", transform: "translateY(32px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
      },
      backgroundImage: {
        "dot-pattern":
          "radial-gradient(circle, rgba(255, 255, 255, 0.18) 1.5px, transparent 1.5px)",
      },
      backgroundSize: {
        dot: "24px 24px",
      },
    },
  },
  plugins: [],
};

export default config;
