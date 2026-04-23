import { SigilLogo } from "@/components/ui/SigilLogo";

export default function MonitorLoading() {
  return (
    <main
      className="min-h-screen bg-canvas flex flex-col"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading monitor"
    >
      <nav className="h-11 border-b border-border flex items-center px-4 gap-2 bg-canvas">
        <SigilLogo size={16} color="#71717a" />
        <span className="font-display font-semibold text-sm text-dim">sygil</span>
      </nav>
      <div className="flex-1 p-4 flex flex-col gap-3">
        <div className="h-5 bg-panel rounded w-64 animate-pulse" />
        <div className="h-40 bg-panel rounded animate-pulse" />
        <div className="h-40 bg-panel rounded animate-pulse" />
      </div>
    </main>
  );
}
