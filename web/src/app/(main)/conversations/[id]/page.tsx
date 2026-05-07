import Link from "next/link";

import { getConversationMeta } from "@/mocks/conversations";

import { ConversationChat } from "../_components/conversation-chat";

export default async function ConversationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = getConversationMeta(id);

  if (!meta) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <h1 className="font-semibold text-lg">Conversation not found</h1>
        <p className="text-muted-foreground text-sm">There is no saved thread with id `{id}`.</p>
        <Link href="/conversations" prefetch={false} className="text-primary text-sm hover:underline">
          ← All conversations
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{meta.title}</h1>
        <p className="text-muted-foreground text-sm">{meta.subtitle}</p>
      </header>
      <ConversationChat key={id} threadId={id} />
    </div>
  );
}
