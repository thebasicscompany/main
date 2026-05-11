import { randomUUID } from 'node:crypto'

export type ManagedHostCapability = 'host_bash' | 'host_file'

export type ManagedHostClient = {
  clientId: string
  interfaceId: string | null
  machineName: string | null
  capabilities: ManagedHostCapability[]
}

type RegisteredClient = ManagedHostClient & {
  send: (frame: Record<string, unknown> & { type: string }) => Promise<void>
  connectedAt: number
}

type PendingHostRequest = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  targetClientId: string
}

const clientsByAssistant = new Map<string, Map<string, RegisteredClient>>()
const pending = new Map<string, PendingHostRequest>()

function key(workspaceId: string, assistantId: string) {
  return `${workspaceId}:${assistantId}`
}

function capabilitiesFor(interfaceId: string | null): ManagedHostCapability[] {
  if (interfaceId?.toLowerCase() === 'macos') return ['host_bash', 'host_file']
  return []
}

export function registerManagedHostClient(input: {
  workspaceId: string
  assistantId: string
  clientId: string | null
  interfaceId: string | null
  machineName: string | null
  send: RegisteredClient['send']
}): ManagedHostClient {
  const clientId = input.clientId?.trim() || randomUUID()
  const client: RegisteredClient = {
    clientId,
    interfaceId: input.interfaceId,
    machineName: input.machineName,
    capabilities: capabilitiesFor(input.interfaceId),
    send: input.send,
    connectedAt: Date.now(),
  }
  const assistantKey = key(input.workspaceId, input.assistantId)
  let clients = clientsByAssistant.get(assistantKey)
  if (!clients) {
    clients = new Map()
    clientsByAssistant.set(assistantKey, clients)
  }
  clients.set(clientId, client)
  return {
    clientId: client.clientId,
    interfaceId: client.interfaceId,
    machineName: client.machineName,
    capabilities: client.capabilities,
  }
}

export function unregisterManagedHostClient(input: {
  workspaceId: string
  assistantId: string
  clientId: string
}) {
  const assistantKey = key(input.workspaceId, input.assistantId)
  const clients = clientsByAssistant.get(assistantKey)
  clients?.delete(input.clientId)
  if (clients?.size === 0) clientsByAssistant.delete(assistantKey)
}

export function listManagedHostClients(input: {
  workspaceId: string
  assistantId: string
}): ManagedHostClient[] {
  return [...(clientsByAssistant.get(key(input.workspaceId, input.assistantId))?.values() ?? [])]
    .map((client) => ({
      clientId: client.clientId,
      interfaceId: client.interfaceId,
      machineName: client.machineName,
      capabilities: client.capabilities,
    }))
}

export function hasManagedHostCapability(input: {
  workspaceId: string
  assistantId: string
  capability: ManagedHostCapability
}): boolean {
  return listManagedHostClients(input).some((client) =>
    client.capabilities.includes(input.capability),
  )
}

export async function dispatchManagedHostRequest(input: {
  workspaceId: string
  assistantId: string
  capability: ManagedHostCapability
  frame: Record<string, unknown> & { type: string }
  timeoutMs?: number
}): Promise<unknown> {
  const client = [...(clientsByAssistant.get(key(input.workspaceId, input.assistantId))?.values() ?? [])]
    .find((candidate) => candidate.capabilities.includes(input.capability))
  if (!client) throw new Error(`No connected host client supports ${input.capability}`)

  const requestId =
    typeof input.frame.requestId === 'string' && input.frame.requestId.trim()
      ? input.frame.requestId
      : randomUUID()
  const frame = { ...input.frame, requestId, targetClientId: client.clientId }
  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Timed out waiting for ${input.capability} result`))
    }, input.timeoutMs ?? 120_000)
    pending.set(requestId, { resolve, reject, timer, targetClientId: client.clientId })
  })

  try {
    await client.send(frame)
  } catch (err) {
    const waiter = pending.get(requestId)
    if (waiter) {
      clearTimeout(waiter.timer)
      pending.delete(requestId)
    }
    throw err
  }

  return result
}

export function completeManagedHostRequest(
  requestId: string,
  result: unknown,
  input: { clientId?: string | null } = {},
): boolean {
  const waiter = pending.get(requestId)
  if (!waiter) return false
  if (input.clientId !== waiter.targetClientId) return false
  clearTimeout(waiter.timer)
  pending.delete(requestId)
  waiter.resolve(result)
  return true
}

export function __resetManagedHostBridgeForTests() {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error('reset'))
  }
  pending.clear()
  clientsByAssistant.clear()
}
