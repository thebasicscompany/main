import type { ReactNode } from "react";

import Image from "next/image";
import Link from "next/link";

import { Globe } from "@/icons";

import { Separator } from "@/components/ui/separator";
import { APP_CONFIG } from "@/config/app-config";

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main>
      <div className="grid h-dvh justify-center p-2 lg:grid-cols-2">
        <div className="relative order-2 hidden h-full rounded-3xl bg-primary lg:flex">
          <div className="absolute top-10 space-y-2 px-10 text-primary-foreground">
            <h1 className="text-2xl font-medium">{APP_CONFIG.name}</h1>
            <p className="text-sm">Run B2B SaaS playbooks in cloud Chrome with live-view, take-over, and audit log.</p>
          </div>

          <div className="absolute bottom-10 flex w-full justify-between px-10">
            <div className="flex-1 space-y-1 text-primary-foreground">
              <h2 className="font-medium">Demonstrate once.</h2>
              <p className="text-sm">Record a workflow in your browser. Cloud Chrome replays it on schedule.</p>
            </div>
            <Separator orientation="vertical" className="mx-3 h-auto!" />
            <div className="flex-1 space-y-1 text-primary-foreground">
              <h2 className="font-medium">Stay in control.</h2>
              <p className="text-sm">Approval gating, take-over, outcome verification — every run audited.</p>
            </div>
          </div>
        </div>
        <div className="relative order-1 flex h-full">
          <Link href="/" prefetch={false} className="absolute left-6 top-6 lg:left-10 lg:top-10" aria-label={APP_CONFIG.name}>
            <Image src="/basics-logo.png" alt="Basics" width={44} height={44} className="rounded-lg" priority />
          </Link>

          {children}

          <div className="absolute bottom-5 flex w-full justify-between px-6 lg:px-10">
            <div className="text-sm">{APP_CONFIG.copyright}</div>
            <div className="flex items-center gap-1 text-sm">
              <Globe className="size-4 text-muted-foreground" />
              ENG
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
