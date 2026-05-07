import type { ReactNode } from "react";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppSidebar } from "@/app/(main)/_components/sidebar/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { userProfileFromSupabase } from "@/lib/auth/user-profile";
import { createClient } from "@/lib/supabase/server";

import { AppMainScroll } from "./_components/app-main-scroll";
import { SearchDialog } from "./_components/sidebar/search-dialog";

export default async function Layout({ children }: Readonly<{ children: ReactNode }>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/auth/v2/login");
  }

  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  const profile = userProfileFromSupabase(user);

  const navUser = {
    name: profile.displayName,
    email: profile.email,
    avatar: profile.avatarUrl ?? "",
  };

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      className="h-svh max-h-svh min-h-0 overflow-hidden"
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 68)",
        } as React.CSSProperties
      }
    >
      <AppSidebar user={navUser} />
      <SidebarInset className="peer-data-[variant=inset]:border min-h-0 overflow-hidden">
        <header className="sticky top-0 z-50 flex h-12 shrink-0 items-center gap-2 overflow-hidden rounded-t-[inherit] border-b bg-background/50 backdrop-blur-md transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex w-full items-center px-4 lg:px-6">
            <div className="flex items-center gap-1 lg:gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
              />
              <SearchDialog />
            </div>
          </div>
        </header>
        <AppMainScroll>{children}</AppMainScroll>
      </SidebarInset>
    </SidebarProvider>
  );
}
