import { WorkflowsGrid } from "./_components/workflows-grid";

export default function WorkflowsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
        <p className="text-muted-foreground text-sm">
          Reusable playbooks. Definitions live in TS modules — use this surface to monitor schedule, success rate, and recent runs.
        </p>
      </header>
      <WorkflowsGrid />
    </div>
  );
}
