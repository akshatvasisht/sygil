import { WorkflowEditor } from "@/components/editor/WorkflowEditor";
import { SigilLogo } from "@/components/ui/SigilLogo";
import Link from "next/link";

export default function EditorPage() {
  return (
    <div className="h-screen bg-canvas flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-border bg-canvas shrink-0">
        <Link href="/" className="flex items-center gap-2 group">
          <SigilLogo size={16} color="var(--dim)" className="group-hover:[&]:opacity-100 transition-opacity duration-200" />
          <span className="font-display font-semibold text-sm text-dim group-hover:text-body transition-colors duration-200">
            sygil
          </span>
        </Link>
      </div>

      <div className="flex-1 overflow-hidden relative">
        <WorkflowEditor />
      </div>
    </div>
  );
}
