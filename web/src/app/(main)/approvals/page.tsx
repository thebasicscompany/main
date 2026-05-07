import { ApprovalsView } from "./_components/approvals-view";

export default function ApprovalsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground text-sm">
          Pause points where the agent needs a human. Approve to let it continue, reject to stop the run cold.
        </p>
      </header>
      <ApprovalsView />
    </div>
  );
}
