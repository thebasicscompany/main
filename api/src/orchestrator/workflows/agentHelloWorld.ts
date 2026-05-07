/**
 * "agent-helloworld" — the Phase 03 vertical slice that proves the
 * computer-use agent loop end-to-end.
 *
 * Sibling of `helloWorld.ts` (which is the non-LLM Phase 01 slice). The
 * orchestrator's workflow registry routes `workflow_id` to either; this
 * one wraps `runAgentLoop` and surfaces the agent's final text on the
 * `agent_summary` SSE event.
 */

import { runAgentLoop } from '../agentLoop.js'
import { publish } from '../eventbus.js'
import type { RunContext } from './helloWorld.js'

const SYSTEM_PROMPT =
  'You are an AI agent running inside a cloud Chrome browser. ' +
  'Use the computer tool to complete the user\'s task. ' +
  'When you are done, write a brief summary of what you accomplished.'

const USER_PROMPT =
  'Navigate to https://github.com/anthropics/anthropic-quickstarts ' +
  'and report the page title.'

export async function runAgentHelloWorld(ctx: RunContext): Promise<void> {
  const result = await runAgentLoop({
    runId: ctx.runId,
    session: ctx.session,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: USER_PROMPT,
    ...(ctx.workspaceId !== undefined ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx.workflowId !== undefined ? { workflowId: ctx.workflowId } : {}),
  })

  // Surface the agent's final summary on a dedicated event. Mirrors the
  // `screenshot_captured` pattern from `helloWorld.ts`: a typed SSE event
  // for a single-shot artifact the dashboard wants to render distinctly.
  publish(ctx.runId, {
    type: 'agent_summary',
    data: {
      text: result.finalText,
      iterations: result.iterations,
      hit_max_iterations: result.hitMaxIterations,
      ts: new Date().toISOString(),
    },
  })
}
