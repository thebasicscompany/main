import type { ReactNode } from "react";

import { Separator } from "@/components/ui/separator";

import { SettingsNav } from "./_components/settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="w-full space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account, workspace, integrations, and more.</p>
      </div>
      <Separator />
      <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
        <aside>
          <SettingsNav />
        </aside>
        <main>{children}</main>
      </div>
    </div>
  );
}
