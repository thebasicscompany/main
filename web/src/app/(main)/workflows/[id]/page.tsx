import { WorkflowDetail } from "./_components/workflow-detail";

type Params = { id: string };

export default async function WorkflowPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;
  return <WorkflowDetail id={id} />;
}
