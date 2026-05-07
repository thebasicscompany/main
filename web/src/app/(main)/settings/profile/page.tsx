import { redirect } from "next/navigation";

import { ProfileSettingsView } from "../_components/profile-settings-view";
import { userProfileFromSupabase } from "@/lib/auth/user-profile";
import { createClient } from "@/lib/supabase/server";

export default async function Page() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/auth/v2/login");
  }

  return <ProfileSettingsView profile={userProfileFromSupabase(user)} />;
}
