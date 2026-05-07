import Link from "next/link";

import { MessageSquare } from "@/icons";

import { conversationThreads } from "@/mocks/conversations";

export default function ConversationsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Conversations</h1>
        <p className="text-muted-foreground text-sm">
          Workspace intelligence chat — mock replies for now (no LLM wired). Threads stay in sync with the sidebar list.
        </p>
      </header>

      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {conversationThreads.map((t) => (
          <li key={t.id}>
            <Link
              href={`/conversations/${t.id}`}
              prefetch={false}
              className="flex gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <MessageSquare className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium leading-snug">{t.title}</div>
                <div className="mt-0.5 text-muted-foreground text-sm">{t.subtitle}</div>
                <div className="mt-2 font-mono text-muted-foreground text-xs">{t.id}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
