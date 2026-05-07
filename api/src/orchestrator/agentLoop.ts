/**
 * Computer-use agent loop, modeled on Anthropic's `computer-use-demo`
 * (`loop.py`'s `sampling_loop`).
 *
 * Shape: kick off with a screenshot of the current page → call the model
 * with the conversation + computer tool → for each `tool_use` in the
 * response, dispatch via the harness and append a `tool_result` message →
 * repeat until `stop_reason: end_turn` or `maxIterations` is hit.
 *
 * SSE side-channel: we emit `model_thinking` (textual reasoning blocks)
 * and `model_tool_use` (tool intent) events so the dashboard timeline can
 * show what the agent is "saying" between actions. Tool execution itself
 * publishes `tool_call_started` / `tool_call_completed` from the
 * dispatcher.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { capture_screenshot } from '@basics/harness'
import type { CdpSession } from '@basics/harness'
import { runMessages } from '../lib/anthropic.js'
import { logger } from '../middleware/logger.js'
import {
  nextStepIndex,
  recordStepStart,
} from './auditWriter.js'
import {
  ComputerUseDispatcher,
  type ComputerToolInput,
} from './computerUseDispatcher.js'
import { publish } from './eventbus.js'
import {
  awaitResume,
  getTakeoverState,
  isTakeoverActive,
} from './takeoverSignal.js'

/**
 * Computer tool definition. The numeric defaults match the Browserbase
 * default viewport (1366x768 — Chrome's headless default). They can be
 * overridden if the runtime ever exposes a custom viewport.
 *
 * Reference: Anthropic computer-use docs § "Computer tool definition".
 */
const COMPUTER_TOOL_DEF: Anthropic.Messages.ToolUnion = {
  type: 'computer_20250124',
  name: 'computer',
  display_width_px: 1366,
  display_height_px: 768,
  display_number: 1,
} as unknown as Anthropic.Messages.ToolUnion

const DEFAULT_MAX_ITERATIONS = 30
const DEFAULT_MAX_TOKENS = 4096

export interface RunAgentLoopOptions {
  runId: string
  session: CdpSession
  systemPrompt: string
  userPrompt: string
  /** Cap on model turns. Default 30 (matches computer-use-demo's default). */
  maxIterations?: number
  /** Per-request `max_tokens`. Default 4096. */
  maxTokens?: number
  /**
   * Approval gate context. Required in production (the dispatcher uses it
   * to gate every mutating computer-use call); left optional here so the
   * Phase 03 unit tests for `runAgentLoop` keep working without wiring a
   * workspace id.
   */
  workspaceId?: string
  workflowId?: string
}

export interface RunAgentLoopResult {
  finalText: string
  iterations: number
  /** True if we stopped because of the iteration cap rather than `end_turn`. */
  hitMaxIterations: boolean
}

/**
 * Drive the computer-use loop until the model emits `end_turn` or we hit
 * the iteration cap.
 */
export async function runAgentLoop(
  opts: RunAgentLoopOptions,
): Promise<RunAgentLoopResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const approvalCtx = opts.workspaceId
    ? {
        workspaceId: opts.workspaceId,
        ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
      }
    : undefined
  const dispatcher = new ComputerUseDispatcher(
    opts.runId,
    opts.session,
    approvalCtx,
  )

  // Initial screenshot — frames the model's first decision. Mirrors
  // computer-use-demo's `_prompt_with_initial_screenshot` pattern.
  const initialShot = await capture_screenshot(opts.session)
  publish(opts.runId, {
    type: 'screenshot_captured',
    data: {
      data_url: `data:image/png;base64,${initialShot.base64}`,
      ts: new Date().toISOString(),
    },
  })

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: opts.userPrompt },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: initialShot.base64,
          },
        },
      ],
    },
  ]

  let iterations = 0
  let finalText = ''
  let hitMaxIterations = false

  while (iterations < maxIterations) {
    iterations++

    // Phase 08: take-over gate. Between LLM iterations (NOT mid-iteration —
    // tool calls in flight finish; the spec keeps the check at the loop
    // boundary per ARCHITECTURE.md:179–207), check whether the user has
    // taken over. If yes, block on `awaitResume`, then capture a fresh
    // screenshot and inject a synthetic user turn so the model sees the
    // current state and the explanation that it was paused.
    if (isTakeoverActive(opts.runId)) {
      const tState = getTakeoverState(opts.runId)
      await awaitResume(opts.runId)

      // Fresh screenshot of the page the user left behind.
      let resumeShot: { base64: string } | null = null
      try {
        resumeShot = await capture_screenshot(opts.session)
        publish(opts.runId, {
          type: 'screenshot_captured',
          data: {
            data_url: `data:image/png;base64,${resumeShot.base64}`,
            ts: new Date().toISOString(),
          },
        })
      } catch (err) {
        logger.warn(
          {
            run_id: opts.runId,
            err: { message: (err as Error).message },
          },
          'post-takeover screenshot failed; continuing without fresh state',
        )
      }

      // Synthetic user turn carrying the explanation + (optionally) the
      // fresh screenshot. The model sees this as a new directive in the
      // conversation thread.
      const explanation =
        'You were paused while the human took over the browser. ' +
        'They have finished and asked you to continue from the current ' +
        'page state shown below. Re-observe the page before issuing any ' +
        'new actions.'
      const resumeContent: Anthropic.MessageParam['content'] = resumeShot
        ? [
            { type: 'text', text: explanation },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: resumeShot.base64,
              },
            },
          ]
        : [{ type: 'text', text: explanation }]
      messages.push({ role: 'user', content: resumeContent })

      const endTs = new Date().toISOString()

      // Phase 09: emit a `trust_grant_suggested` event so a future
      // overlay/dashboard can render an "Auto-approve <last few user
      // actions> next time?" prompt. v1 design (locked by Phase 09
      // ROADMAP):
      //  - The runtime backend NEVER writes `runtime_trust_grants` rows
      //    from this hook. Trust grants are explicitly user-created via
      //    POST /v1/runtime/trust-grants (or the existing approval
      //    `remember=true` shortcut). Auto-creation here would silently
      //    widen the trust surface against the "narrow by default" rule
      //    in PROJECT.md "Conventions".
      //  - The actual suggestion engine — extracting "last few user
      //    actions" from the Browserbase CDP timeline during the
      //    takeover window — needs CDP event-log access we don't have
      //    yet. v1 emits an empty `suggestedActions: []`; the event
      //    seam lands so downstream UI can subscribe today and the
      //    engine can be filled in later (Phase 10+ concern).
      // Inputs available when richer suggestions land:
      //   tState.startedAt, tState.startedBy, plus the CDP event log
      //   over the takeover window.
      publish(opts.runId, {
        type: 'trust_grant_suggested',
        data: {
          run_id: opts.runId,
          takeover_started_at: tState.startedAt,
          takeover_ended_at: endTs,
          // v1: always empty until the suggestion engine is wired
          // (Phase 10+). The shape per item is documented at the
          // route layer / contract: { action_pattern, last_seen_at,
          // count }.
          suggested_actions: [] as Array<{
            action_pattern: string
            last_seen_at: string
            count: number
          }>,
          ts: endTs,
        },
      })

      // Record the user_takeover end step so the timeline shows a clean
      // start→end pair (the route handler recorded the start).
      try {
        await recordStepStart({
          runId: opts.runId,
          stepIndex: nextStepIndex(opts.runId),
          kind: 'user_takeover',
          payload: {
            phase: 'ended',
            started_at: tState.startedAt,
            started_by: tState.startedBy,
            ended_at: endTs,
            iteration: iterations,
          },
        })
      } catch (err) {
        logger.warn(
          {
            run_id: opts.runId,
            err: { message: (err as Error).message },
          },
          'audit recordStepStart(user_takeover/ended) failed; loop continues',
        )
      }
    }

    const response = await runMessages({
      system: opts.systemPrompt,
      // Pass a shallow copy so the wrapper (which adds cache_control to a
      // copy internally) and any test mocks see the snapshot at call time
      // rather than a reference that mutates as we push later turns.
      messages: messages.slice(),
      tools: [COMPUTER_TOOL_DEF],
      maxTokens,
    })

    // Append the assistant turn verbatim. Per `shared/prompt-caching.md`
    // and the Anthropic SDK contract, we must preserve the full content
    // array (text + tool_use blocks) on the message we send back next
    // turn — extracting only `.text` would break tool_use_id matching.
    messages.push({
      role: 'assistant',
      content:
        response.content as unknown as Anthropic.MessageParam['content'],
    })

    // Surface text-content reasoning to the SSE timeline. Emits one event
    // per text block so a multi-paragraph thought arrives as separate
    // entries (UI can choose to coalesce).
    //
    // Phase 05: persist each model_thinking / model_tool_use block as a
    // typed step in `runtime_run_steps` alongside the live SSE emit. The
    // DB row is the durable timeline; the eventbus is the live preview.
    // Audit writes are best-effort — a DB hiccup must not break the loop.
    const textChunks: string[] = []
    const toolUses: Array<{ id: string; name: string; input: unknown }> = []
    for (const block of response.content) {
      if (block.type === 'text') {
        textChunks.push(block.text)
        const ts = new Date().toISOString()
        publish(opts.runId, {
          type: 'model_thinking' as const,
          data: { text: block.text, ts },
        })
        try {
          await recordStepStart({
            runId: opts.runId,
            stepIndex: nextStepIndex(opts.runId),
            kind: 'model_thinking',
            payload: {
              text: block.text,
              iteration: iterations,
              ts,
            },
          })
        } catch (err) {
          logger.warn(
            {
              run_id: opts.runId,
              err: { message: (err as Error).message },
            },
            'audit recordStepStart(model_thinking) failed; loop continues',
          )
        }
      } else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input })
        const ts = new Date().toISOString()
        publish(opts.runId, {
          type: 'model_tool_use' as const,
          data: {
            tool: block.name,
            input: block.input as Record<string, unknown>,
            tool_use_id: block.id,
            ts,
          },
        })
        try {
          await recordStepStart({
            runId: opts.runId,
            stepIndex: nextStepIndex(opts.runId),
            kind: 'model_tool_use',
            payload: {
              tool: block.name,
              input: block.input as Record<string, unknown>,
              tool_use_id: block.id,
              iteration: iterations,
              ts,
            },
          })
        } catch (err) {
          logger.warn(
            {
              run_id: opts.runId,
              err: { message: (err as Error).message },
            },
            'audit recordStepStart(model_tool_use) failed; loop continues',
          )
        }
      }
    }

    // No tool_use blocks → conversation is done. `stop_reason` should be
    // `end_turn` here; we trust the absence of tool_use over the field
    // since the field shape is the source-of-truth invariant Anthropic
    // documents for computer-use loops.
    if (toolUses.length === 0) {
      finalText = textChunks.join('\n').trim()
      logger.info(
        { run_id: opts.runId, iterations, stop_reason: response.stop_reason },
        'agent loop: end_turn',
      )
      return { finalText, iterations, hitMaxIterations: false }
    }

    // Dispatch each tool_use, collect the tool_result blocks, and ship
    // them back as a single user-role message. Anthropic requires *all*
    // tool_results for an assistant turn in one user message — splitting
    // them across multiple user messages is a 400.
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      if (tu.name !== 'computer') {
        // Phase 03: only the `computer` tool is registered. Defend
        // anyway — return a synthetic error block so the model can adapt.
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: [
            { type: 'text', text: `unknown tool: ${tu.name}` },
          ],
          is_error: true,
        })
        continue
      }
      const result = await dispatcher.dispatch(
        tu.id,
        tu.input as ComputerToolInput,
      )
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.content as unknown as Anthropic.Messages.ToolResultBlockParam['content'],
        ...(result.isError ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: toolResultBlocks })
  }

  hitMaxIterations = true
  logger.warn(
    { run_id: opts.runId, max_iterations: maxIterations },
    'agent loop: max_iterations reached',
  )
  // Return whatever final text we accumulated. May be empty if the last
  // turn was pure tool_use.
  return { finalText, iterations, hitMaxIterations }
}
