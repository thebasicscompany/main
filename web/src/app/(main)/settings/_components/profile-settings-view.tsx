"use client";

import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UserProfile } from "@/types/settings";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]!.charAt(0)}${parts[parts.length - 1]!.charAt(0)}`.toUpperCase();
}

export function ProfileSettingsView({ profile }: { readonly profile: UserProfile }) {
  const [name, setName] = useState(profile.displayName);
  const [email, setEmail] = useState(profile.email);

  useEffect(() => {
    setName(profile.displayName);
    setEmail(profile.email);
  }, [profile.displayName, profile.email]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Profile</h2>
        <p className="text-sm text-muted-foreground">
          Loaded from your Supabase session. Saving edits here is local-only until we wire profile updates (or use Supabase
          dashboard / OAuth provider metadata).
        </p>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <Avatar size="lg" className="size-16">
          {profile.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt="" /> : null}
          <AvatarFallback className="text-base">{initials(profile.displayName)}</AvatarFallback>
        </Avatar>

        <div className="grid max-w-md flex-1 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="profile-name">Display name</Label>
            <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="profile-email">Email</Label>
            <Input
              id="profile-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button type="button" size="sm">
              Save changes
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setName(profile.displayName);
                setEmail(profile.email);
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
