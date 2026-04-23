import { SigilLogo } from "@/components/ui/SigilLogo";

export default function RootLoading() {
  return (
    <main
      className="min-h-screen flex items-center justify-center bg-canvas"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-dim">
        <SigilLogo size={32} color="#71717a" />
        <span className="font-mono text-sm uppercase tracking-wider">Loading…</span>
      </div>
    </main>
  );
}
