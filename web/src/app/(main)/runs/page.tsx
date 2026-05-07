import { RunsTable } from "./_components/runs-table";

export default function RunsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="text-muted-foreground text-sm">
          Live runs pin to the top. Click any row to inspect timeline, live view, and verification outcome.
        </p>
      </header>
      <RunsTable />
    </div>
  );
}
