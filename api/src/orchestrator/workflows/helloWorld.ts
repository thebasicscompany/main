/**
 * Hardcoded "open example.com and screenshot" workflow.
 *
 * This is the Phase 01 vertical slice — no LLM, no agent loop, just two
 * harness calls in sequence. Phase 03 replaces this with a registry of
 * Vercel-AI-SDK-driven playbooks.
 *
 * The workflow stays deliberately ignorant of the eventbus and runState
 * shape: it gets a plain `emit(type, data)` from the orchestrator and
 * focuses on issuing tool calls + measuring their wall-clock duration.
 */

import { capture_screenshot, goto_url, wait_for_load } from '@basics/harness'
import type { CdpSession } from '@basics/harness'

export interface RunContext {
  runId: string
  session: CdpSession
  emit: (type: string, data: Record<string, unknown>) => void
  /**
   * Carried for downstream consumers (e.g. the agent loop's approval gate).
   * Optional so the Phase 01 hello-world workflow can ignore them entirely.
   */
  workspaceId?: string
  workflowId?: string
}

const TARGET_URL = 'https://example.com'

export async function runHelloWorld(ctx: RunContext): Promise<void> {
  const { session, emit } = ctx

  // -- Step 1: navigate ----------------------------------------------------
  const navStart = Date.now()
  emit('tool_call_started', {
    tool: 'navigate',
    params: { url: TARGET_URL },
    ts: new Date().toISOString(),
  })
  await goto_url(session, TARGET_URL)
  await wait_for_load(session)
  emit('tool_call_completed', {
    tool: 'navigate',
    duration_ms: Date.now() - navStart,
    ts: new Date().toISOString(),
  })

  // -- Step 2: screenshot --------------------------------------------------
  const shotStart = Date.now()
  emit('tool_call_started', {
    tool: 'capture_screenshot',
    params: {},
    ts: new Date().toISOString(),
  })
  const shot = await capture_screenshot(session)
  const dataUrl = `data:image/${shot.format};base64,${shot.base64}`
  emit('screenshot_captured', {
    data_url: dataUrl,
    ts: new Date().toISOString(),
  })
  emit('tool_call_completed', {
    tool: 'capture_screenshot',
    screenshot_data_url: dataUrl,
    duration_ms: Date.now() - shotStart,
    ts: new Date().toISOString(),
  })
}
