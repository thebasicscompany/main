/**
 * Maps Anthropic `computer_20250124` tool calls to harness CDP helpers.
 *
 * Reference: Anthropic computer-use spec (`computer_20250124`) plus the
 * official `computer-use-demo` ToolResult shape. The model sends:
 *   { name: "computer", input: { action: "...", coordinate?: [x,y], text?, ... } }
 * and expects back a list of content blocks — at minimum a screenshot
 * image, optionally an error text block when something went wrong.
 *
 * Each dispatched action ends with a fresh screenshot (the standard
 * computer-use loop pattern — every step closes with a new view of the
 * world for the model to reason about on the next turn).
 *
 * Phase 03 scope: only the `computer` tool is dispatched here. Custom
 * tools (`navigate`, `js`, ...) come in later phases per ARCHITECTURE.md.
 */

import {
  capture_screenshot,
  click_at_xy,
  press_key,
  scroll,
  type_text,
  wait,
} from '@basics/harness'
import type { CdpSession, MouseButton } from '@basics/harness'
import { gateToolCall } from '../middleware/approval.js'
import { logger } from '../middleware/logger.js'
import {
  nextStepIndex,
  recordToolCallEnd,
  recordToolCallStart,
} from './auditWriter.js'
import { publish } from './eventbus.js'

/** Action discriminator from `computer_20250124.input.action`. */
export type ComputerAction =
  | 'screenshot'
  | 'mouse_move'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'left_click_drag'
  | 'key'
  | 'type'
  | 'cursor_position'
  | 'wait'
  | 'scroll'

/** The shape of `input` we accept on a computer tool call. */
export interface ComputerToolInput {
  action: ComputerAction
  coordinate?: [number, number]
  start_coordinate?: [number, number]
  text?: string
  duration?: number
  /** scroll-only fields (computer_20250124 has these via newer revisions). */
  scroll_direction?: 'up' | 'down' | 'left' | 'right'
  scroll_amount?: number
}

/**
 * Anthropic tool-result content block shape. We narrow to the two block
 * types we ever emit: image (screenshot) and text (error description).
 */
export type ToolResultBlock =
  | {
      type: 'image'
      source: { type: 'base64'; media_type: 'image/png'; data: string }
    }
  | { type: 'text'; text: string }

export interface DispatchResult {
  /** Content blocks to ship back as `tool_result.content`. */
  content: ToolResultBlock[]
  /** Whether to set `is_error: true` on the tool_result. */
  isError: boolean
}

/**
 * Approval gate context — when present, every mutating computer-use action
 * is funneled through `gateToolCall` before the harness executes it. The
 * agent loop wires this in from the run's workflow + workspace metadata.
 *
 * Optional so unit tests that target the dispatcher in isolation (no run
 * record, no DB) can leave it off and observe the legacy "always allow"
 * behavior. Production paths always set it.
 */
export interface DispatcherApprovalContext {
  workspaceId: string
  workflowId?: string
}

/** Computer-use actions that mutate external state — must flow through approval. */
const MUTATING_ACTIONS: ReadonlySet<ComputerAction> = new Set([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'key',
  'type',
])

/**
 * Whether the action requires human approval before execution. Read-only
 * actions (`screenshot`, `mouse_move`, `cursor_position`, `wait`, `scroll`)
 * bypass the gate. `scroll` is treated as read-only because it changes
 * viewport but never touches external state.
 */
export function actionRequiresApproval(action: ComputerAction): boolean {
  return MUTATING_ACTIONS.has(action)
}

/**
 * Dispatch a single `computer_20250124` tool call.
 *
 * The dispatcher tracks last-known cursor position across calls (used only
 * for the `cursor_position` action, which has no CDP equivalent — see
 * comment below) but is otherwise stateless.
 */
export class ComputerUseDispatcher {
  private lastCursor: [number, number] = [0, 0]

  constructor(
    private readonly runId: string,
    private readonly session: CdpSession,
    private readonly approvalCtx?: DispatcherApprovalContext,
  ) {}

  /**
   * Execute a tool call and return the tool_result content blocks.
   *
   * Emits `tool_call_started` before execution and `tool_call_completed`
   * after — the dashboard timeline relies on this pair-shape.
   */
  async dispatch(
    toolUseId: string,
    input: ComputerToolInput,
  ): Promise<DispatchResult> {
    const action = input.action
    const startedAt = Date.now()
    const toolName = `computer.${action}`

    // Allocate the step index for this call up-front so the eventbus emit
    // and the audit row share the same ordinal. Both surfaces should agree
    // on "this was step N of the run".
    const stepIndex = nextStepIndex(this.runId)

    publish(this.runId, {
      type: 'tool_call_started',
      data: {
        tool: 'computer',
        action,
        params: input as unknown as Record<string, unknown>,
        tool_use_id: toolUseId,
        step_index: stepIndex,
        ts: new Date().toISOString(),
      },
    })

    // Phase 05: persist the pre-execution row immediately so a partial
    // failure (harness throws, process dies) still leaves a forensic trail.
    // The post-execution UPDATE lands in `recordToolCallEnd` below, success
    // OR failure path. Audit failure is best-effort: a DB hiccup must not
    // break tool dispatch.
    let toolCallId: string | null = null
    try {
      const rec = await recordToolCallStart({
        runId: this.runId,
        stepIndex,
        toolName,
        params: input as unknown as Record<string, unknown>,
      })
      toolCallId = rec.toolCallId
    } catch (err) {
      logger.warn(
        {
          run_id: this.runId,
          action,
          err: { message: (err as Error).message },
        },
        'audit recordToolCallStart failed; tool dispatch continues',
      )
    }

    // Phase 04B: gate every dispatch through the approval middleware.
    // `gateToolCall` itself short-circuits on `requiresApproval=false`, so
    // the call is always made; the result tells us whether to execute,
    // skip with a synthetic "user rejected" error, or skip with a timeout
    // error. The gate is a no-op when no approval context is wired (unit
    // tests that target the dispatcher in isolation).
    let denialText: string | null = null
    let approvalId: string | null = null
    let trustGrantId: string | null = null
    if (this.approvalCtx) {
      const decision = await gateToolCall({
        runId: this.runId,
        workspaceId: this.approvalCtx.workspaceId,
        ...(this.approvalCtx.workflowId !== undefined
          ? { workflowId: this.approvalCtx.workflowId }
          : {}),
        toolName,
        params: input as unknown as Record<string, unknown>,
        requiresApproval: actionRequiresApproval(action),
        emit: (e) => publish(this.runId, e),
      })
      if (decision.kind === 'deny') {
        denialText = `user rejected: ${decision.reason}`
        approvalId = decision.approvalId
      } else if (decision.via === 'user_approved') {
        approvalId = decision.approvalId
      } else if (decision.via === 'trust_grant') {
        trustGrantId = decision.grantId
      }
    }

    let errorText: string | null = null
    const browserStartedAt = Date.now()
    if (denialText) {
      // Skip executing the harness call entirely. The trailing screenshot
      // still runs so the model sees post-state and can adapt.
      errorText = denialText
    } else {
      try {
        await this.executeAction(input)
      } catch (err) {
        errorText = err instanceof Error ? err.message : String(err)
        logger.warn(
          { run_id: this.runId, action, err: { message: errorText } },
          'computer-use action failed',
        )
      }
    }

    // Per Anthropic computer-use-demo: every action closes with a fresh
    // screenshot, even on error. The model needs the post-state to decide
    // its next move.
    let screenshotData: string | null = null
    try {
      const shot = await capture_screenshot(this.session)
      screenshotData = shot.base64
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Screenshot failure is itself worth surfacing — flag it but don't
      // throw, so the loop can continue.
      errorText = errorText
        ? `${errorText}; screenshot failed: ${msg}`
        : `screenshot failed: ${msg}`
    }
    const browserLatencyMs = Date.now() - browserStartedAt

    const content: ToolResultBlock[] = []
    if (errorText) {
      content.push({ type: 'text', text: errorText })
    }
    if (screenshotData) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: screenshotData,
        },
      })
    }

    const dataUrl = screenshotData
      ? `data:image/png;base64,${screenshotData}`
      : null

    publish(this.runId, {
      type: 'tool_call_completed',
      data: {
        tool: 'computer',
        action,
        tool_use_id: toolUseId,
        step_index: stepIndex,
        duration_ms: Date.now() - startedAt,
        ...(dataUrl ? { screenshot_data_url: dataUrl } : {}),
        ...(errorText ? { error: errorText } : {}),
        ts: new Date().toISOString(),
      },
    })
    if (dataUrl) {
      publish(this.runId, {
        type: 'screenshot_captured',
        data: { data_url: dataUrl, ts: new Date().toISOString() },
      })
    }

    // Phase 05: post-execution UPDATE on the same row. The result JSONB
    // carries the content blocks (text + inline base64 screenshot) so a
    // CFO replay reproduces exactly what the model saw.
    //
    // TODO(Phase 05.5): screenshot bytes move to S3 — `result` will store
    // a `{ screenshot_s3_key }` reference and `screenshotS3Key` column
    // will be populated here instead of inlining base64. The
    // RuntimeScreenshotsBucket is already provisioned in `sst.config.ts`.
    if (toolCallId) {
      try {
        await recordToolCallEnd({
          toolCallId,
          result: { content: content as unknown as Record<string, unknown>[] },
          error: errorText,
          browserLatencyMs,
          ...(approvalId ? { approvalId } : {}),
          ...(trustGrantId ? { trustGrantId } : {}),
        })
      } catch (err) {
        logger.warn(
          {
            run_id: this.runId,
            action,
            tool_call_id: toolCallId,
            err: { message: (err as Error).message },
          },
          'audit recordToolCallEnd failed; tool dispatch result preserved',
        )
      }
    }

    return { content, isError: errorText !== null }
  }

  /**
   * Execute the action. Each branch maps a single Anthropic action onto a
   * harness call (or, for actions without a dedicated helper, a small set
   * of CDP messages dispatched via `session.client.send`).
   */
  private async executeAction(input: ComputerToolInput): Promise<void> {
    const { action } = input
    switch (action) {
      case 'screenshot':
        // No-op besides the trailing screenshot the wrapper always takes.
        return

      case 'mouse_move': {
        const [x, y] = requireCoordinate(input)
        // No dedicated helper for "move only". Per ARCHITECTURE.md scope
        // rules ("don't modify harness in this phase"), use the underlying
        // CDP client directly. CDP `Input.dispatchMouseEvent` with type
        // 'mouseMoved' synthesizes a pointer move without press/release.
        await sendCdp(this.session, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
        })
        this.lastCursor = [x, y]
        return
      }

      case 'left_click':
      case 'right_click':
      case 'middle_click': {
        const [x, y] = requireCoordinate(input)
        const button = mapButton(action)
        await click_at_xy(this.session, x, y, button)
        this.lastCursor = [x, y]
        return
      }

      case 'double_click':
      case 'triple_click': {
        const [x, y] = requireCoordinate(input)
        const clicks = action === 'double_click' ? 2 : 3
        await click_at_xy(this.session, x, y, 'left', clicks)
        this.lastCursor = [x, y]
        return
      }

      case 'left_click_drag': {
        // Two coordinates: start (start_coordinate or last cursor) → end
        // (coordinate). The harness has no drag helper; we synthesize with
        // raw CDP. Pattern: mousePressed at start, mouseMoved to end,
        // mouseReleased at end. Mirrors browser-use's drag impl
        // (controller/service.py `drag` handler).
        const [ex, ey] = requireCoordinate(input)
        const start = input.start_coordinate ?? this.lastCursor
        const [sx, sy] = start

        await sendCdp(this.session, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: sx,
          y: sy,
          button: 'left',
          clickCount: 1,
        })
        await sendCdp(this.session, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: ex,
          y: ey,
          button: 'left',
        })
        await sendCdp(this.session, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: ex,
          y: ey,
          button: 'left',
          clickCount: 1,
        })
        this.lastCursor = [ex, ey]
        return
      }

      case 'key': {
        // Anthropic's `key` carries an xdotool-style descriptor:
        // "ctrl+a", "Return", "shift+Tab", etc. Parse to (modifiers, key).
        if (!input.text) {
          throw new Error('key action requires `text`')
        }
        const { key, modifiers } = parseKeyDescriptor(input.text)
        await press_key(this.session, key, modifiers)
        return
      }

      case 'type': {
        if (input.text === undefined || input.text === null) {
          throw new Error('type action requires `text`')
        }
        await type_text(this.session, input.text)
        return
      }

      case 'cursor_position': {
        // No CDP query for "where is the cursor". Anthropic's reference
        // computer-use tool returns a synthetic position; we return the
        // last known position the model itself moved to. Pre-screenshot
        // (e.g. session start) the value is (0, 0).
        return
      }

      case 'wait': {
        const seconds = input.duration ?? 1
        await wait(seconds)
        return
      }

      case 'scroll': {
        // Newer computer_20250124 revisions include a scroll action.
        const [x, y] = requireCoordinate(input)
        const amount = input.scroll_amount ?? 3
        const dir = input.scroll_direction ?? 'down'
        // CDP wheel: positive deltaY = scroll down, negative = scroll up.
        const px = amount * 100
        const dy = dir === 'down' ? px : dir === 'up' ? -px : 0
        const dx = dir === 'right' ? px : dir === 'left' ? -px : 0
        await scroll(this.session, x, y, dy, dx)
        this.lastCursor = [x, y]
        return
      }

      default: {
        // Future-proof: surface unknown actions as a tool error rather
        // than crashing the loop. The model can adapt.
        throw new Error(`unsupported computer action: ${action as string}`)
      }
    }
  }
}

/** Send a raw CDP command via the harness's exposed client. */
async function sendCdp(
  session: CdpSession,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  // Cast through `unknown` because chrome-remote-interface types `send`
  // with a literal-union method name; the dispatcher needs arbitrary
  // strings (mirrors the harness's own `cdp()` helper in `internal.ts`).
  const send = (
    session.client as unknown as {
      send: (
        method: string,
        params?: Record<string, unknown>,
        sessionId?: string,
      ) => Promise<unknown>
    }
  ).send.bind(session.client)
  await send(method, params, session.sessionId)
}

function requireCoordinate(input: ComputerToolInput): [number, number] {
  if (!input.coordinate || input.coordinate.length !== 2) {
    throw new Error(`${input.action} action requires \`coordinate: [x, y]\``)
  }
  const [x, y] = input.coordinate
  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new Error(`${input.action} action: coordinate must be [number, number]`)
  }
  return [x, y]
}

function mapButton(
  action: 'left_click' | 'right_click' | 'middle_click',
): MouseButton {
  switch (action) {
    case 'left_click':
      return 'left'
    case 'right_click':
      return 'right'
    case 'middle_click':
      return 'middle'
  }
}

/**
 * Parse an xdotool-style key descriptor into a (key, modifiers-bitmask)
 * pair compatible with `press_key`. Examples:
 *   "Return"         → { key: "Enter",   modifiers: 0 }
 *   "ctrl+a"         → { key: "a",       modifiers: 2 }
 *   "shift+ctrl+t"   → { key: "t",       modifiers: 2|8 = 10 }
 *
 * Modifier bitfield (CDP `Input.dispatchKeyEvent.modifiers`):
 *   1 = Alt, 2 = Ctrl, 4 = Meta (Cmd), 8 = Shift.
 */
export function parseKeyDescriptor(descriptor: string): {
  key: string
  modifiers: number
} {
  const parts = descriptor.split('+').map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) return { key: descriptor, modifiers: 0 }

  let modifiers = 0
  let baseKey = parts[parts.length - 1]!
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i]!.toLowerCase()
    switch (mod) {
      case 'alt':
      case 'option':
        modifiers |= 1
        break
      case 'ctrl':
      case 'control':
        modifiers |= 2
        break
      case 'meta':
      case 'cmd':
      case 'command':
      case 'super':
      case 'win':
        modifiers |= 4
        break
      case 'shift':
        modifiers |= 8
        break
      default:
        // Unknown modifier — treat as part of the base key (defensive).
        baseKey = `${mod}+${baseKey}`
    }
  }

  // Translate xdotool aliases to harness key names (KEYS table in helpers.ts).
  const aliasMap: Record<string, string> = {
    Return: 'Enter',
    return: 'Enter',
    KP_Enter: 'Enter',
    space: ' ',
    Page_Up: 'PageUp',
    Page_Down: 'PageDown',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    BackSpace: 'Backspace',
    Esc: 'Escape',
  }
  const mapped = aliasMap[baseKey] ?? baseKey
  return { key: mapped, modifiers }
}
