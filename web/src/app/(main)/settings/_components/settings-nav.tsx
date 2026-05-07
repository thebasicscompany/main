"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { CalendarClock, Building2, Code2, Plug, ShieldCheck, UserCog } from "@/icons";

import { cn } from "@/lib/utils";

const sections = [
  { title: "Profile", url: "/settings/profile", icon: UserCog },
  { title: "Workspace", url: "/settings/workspace", icon: Building2 },
  { title: "Integrations", url: "/settings/integrations", icon: Plug },
  { title: "Trust", url: "/settings/trust", icon: ShieldCheck },
  { title: "Schedules", url: "/settings/schedules", icon: CalendarClock },
  { title: "Developer", url: "/settings/developer", icon: Code2 },
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-row gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {sections.map((s) => {
        const isActive = pathname === s.url || pathname.startsWith(`${s.url}/`);
        return (
          <Link
            key={s.url}
            href={s.url}
            prefetch={false}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
          >
            <s.icon className="h-4 w-4" />
            {s.title}
          </Link>
        );
      })}
    </nav>
  );
}
