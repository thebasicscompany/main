import { Globe } from "@/icons";
import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      icon={Globe}
      title="Context"
      description="Browserbase Context inspector — which SaaS apps are logged in for the workspace, last sync timestamps, force-resync. Wired in W4."
    />
  );
}
