import type { Icon } from "@/icons";

type Props = {
  icon: Icon;
  title: string;
  description: string;
};

export function RoutePlaceholder({ icon: Icon, title, description }: Props) {
  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Icon className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </div>
      <span className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">Coming in W2–W4</span>
    </div>
  );
}
