import { randomUUID } from 'node:crypto'

export type CloudChatEventFrame = Record<string, unknown> & { type: string }

type Subscriber = {
  id: string
  workspaceId: string
  assistantId: string
  send: (frame: CloudChatEventFrame) => Promise<void>
}

const subscribers = new Map<string, Subscriber>()
let nextSubscriberId = 0

function key(workspaceId: string, assistantId: string) {
  return `${workspaceId}:${assistantId}`
}

export function subscribeCloudChatEvents(input: {
  workspaceId: string
  assistantId: string
  send: Subscriber['send']
}): () => void {
  const id = `${Date.now()}:${++nextSubscriberId}`
  subscribers.set(id, {
    id,
    workspaceId: input.workspaceId,
    assistantId: input.assistantId,
    send: input.send,
  })
  return () => {
    subscribers.delete(id)
  }
}

export async function publishCloudChatEvent(
  input: {
    workspaceId: string
    assistantId: string
  },
  frame: CloudChatEventFrame,
) {
  const assistantKey = key(input.workspaceId, input.assistantId)
  const targets = [...subscribers.values()].filter(
    (subscriber) => key(subscriber.workspaceId, subscriber.assistantId) === assistantKey,
  )
  await Promise.allSettled(targets.map((subscriber) => subscriber.send(frame)))
}

export function buildCloudAssistantEvent(frame: CloudChatEventFrame) {
  const conversationId =
    typeof frame.conversationId === 'string' ? frame.conversationId : undefined
  return {
    id: randomUUID(),
    conversationId,
    emittedAt: new Date().toISOString(),
    message: frame,
  }
}

export function __resetCloudChatEventHubForTests() {
  subscribers.clear()
  nextSubscriberId = 0
}
