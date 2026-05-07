"use client";

import { useMemo } from "react";

import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
  useLocalRuntime,
} from "@assistant-ui/react";

import { getConversationInitialMessages, mockAssistantReply } from "@/mocks/conversations";

import { BasicsThread } from "./basics-thread";

function extractLastUserText(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const texts = m.content.filter((p): p is { type: "text"; text: string } => p.type === "text");
    return texts.map((p) => p.text).join("\n");
  }
  return "";
}

function createMockAdapter(threadId: string): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const userText = extractLastUserText(messages);
      const reply = mockAssistantReply(threadId, userText);
      const step = 16;
      let acc = "";
      for (let i = 0; i < reply.length && !abortSignal.aborted; i += step) {
        acc += reply.slice(i, i + step);
        yield { content: [{ type: "text", text: acc }] };
        await new Promise((r) => setTimeout(r, 32));
      }
    },
  };
}

export function ConversationChat({ threadId }: { threadId: string }) {
  const initialMessages = useMemo(
    () => [...getConversationInitialMessages(threadId)] as ThreadMessageLike[],
    [threadId],
  );
  const adapter = useMemo(() => createMockAdapter(threadId), [threadId]);
  const runtime = useLocalRuntime(adapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <BasicsThread />
    </AssistantRuntimeProvider>
  );
}
