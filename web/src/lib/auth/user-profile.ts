import type { User } from "@supabase/supabase-js";

import type { UserProfile } from "@/types/settings";

export function userProfileFromSupabase(user: User): UserProfile {
  const fullName =
    typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim() : "";
  const avatarUrl =
    typeof user.user_metadata?.avatar_url === "string" ? user.user_metadata.avatar_url : undefined;

  return {
    id: user.id,
    displayName: fullName || user.email?.split("@")[0] || "Account",
    email: user.email ?? "",
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}
