import { FileSearch } from "@/icons";
import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      icon={FileSearch}
      title="Audit"
      description="Workspace-wide audit log. Filterable, exportable. Wired in W4."
    />
  );
}
