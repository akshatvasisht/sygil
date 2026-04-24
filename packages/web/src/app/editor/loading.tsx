import { SigilLogo } from "@/components/ui/SigilLogo";

export default function EditorLoading() {
  return (
    <main
      className="min-h-screen bg-canvas flex flex-col"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading editor"
    >
      <nav className="h-11 border-b border-border flex items-center px-4 gap-2 bg-canvas">
        <SigilLogo size={16} color="#71717a" />
        <span className="font-display font-semibold text-sm text-dim">sygil</span>
      </nav>
      <div className="flex-1 flex">
        <aside className="w-56 border-r border-border p-3 flex flex-col gap-2">
          <div className="h-4 bg-panel rounded animate-pulse" />
          <div className="h-20 bg-panel rounded animate-pulse" />
          <div className="h-20 bg-panel rounded animate-pulse" />
        </aside>
        <div className="flex-1 flex items-center justify-center text-dim font-mono text-xs uppercase tracking-wider">
          Loading canvas…
        </div>
      </div>
    </main>
  );
}
