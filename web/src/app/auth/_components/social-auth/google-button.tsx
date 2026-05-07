"use client";

import { useSearchParams } from "next/navigation";

import { useState } from "react";
import { siGoogle } from "simple-icons";
import { toast } from "sonner";

import { SimpleIcon } from "@/components/simple-icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

export function GoogleButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  const params = useSearchParams();
  const [isPending, setIsPending] = useState(false);

  const onClick = async () => {
    setIsPending(true);
    const supabase = createClient();
    const redirect = params.get("redirect") ?? "/";
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
      },
    });
    if (error) {
      setIsPending(false);
      toast.error("Google sign-in failed", { description: error.message });
    }
  };

  return (
    <Button variant="secondary" className={cn(className)} onClick={onClick} disabled={isPending} {...props}>
      <SimpleIcon icon={siGoogle} className="size-4" />
      {isPending ? "Redirecting…" : "Continue with Google"}
    </Button>
  );
}
