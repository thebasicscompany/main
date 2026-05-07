import { RunDetail } from "./_components/run-detail";

type Params = { runId: string };

export default async function RunDetailPage({ params }: { params: Promise<Params> }) {
  const { runId } = await params;
  return <RunDetail runId={runId} />;
}
  