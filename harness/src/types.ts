/**
 * Shared type definitions for @basics/harness.
 *
 * Pure types, no runtime code. Imported by both `session.ts` and `helpers.ts`.
 */

import type CDP from 'chrome-remote-interface'

/** Tuple-style key descriptor: (windowsVirtualKeyCode, code, text). */
export type KeyDescriptor = readonly [number, string, string]

/** Mouse buttons accepted by `Input.dispatchMouseEvent`. */
export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward' | 'none'

/** A 2D point in CSS pixels. */
export interface Point {
  x: number
  y: number
}

/**
 * Bitfield for CDP `Input.dispatchKeyEvent.modifiers`.
 *
 * The Chrome DevTools Protocol encodes modifier keys as a bitmask:
 *   1 = Alt
 *   2 = Ctrl
 *   4 = Meta (Cmd on macOS)
 *   8 = Shift
 *
 * Combine with bitwise OR: `Modifiers.Ctrl | Modifiers.Shift`.
 */
export const Modifiers = {
  None: 0,
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
} as const
export type KeyModifiers = number

/** What `page_info()` returns when no native dialog is open. */
export interface PageInfo {
  url: string
  title: string
  /** innerWidth */
  w: number
  /** innerHeight */
  h: number
  /** scrollX */
  sx: number
  /** scrollY */
  sy: number
  /** documentElement.scrollWidth */
  pw: number
  /** documentElement.scrollHeight */
  ph: number
}

/** What `page_info()` returns when a native dialog is open. */
export interface PageDialog {
  dialog: {
    type: string
    message: string
    [k: string]: unknown
  }
}

export type PageInfoResult = PageInfo | PageDialog

/** A tab (page-type Target). */
export interface TabInfo {
  targetId: string
  title: string
  url: string
}

/** Subset of CDP `Target.TargetInfo` we surface for `current_tab()`. */
export interface CurrentTabInfo {
  targetId: string | undefined
  url: string
  title: string
}

/** Screenshot options. */
export interface ScreenshotOptions {
  /** Optional file path; if set, the bytes are written to disk and the path is returned in `path`. */
  path?: string
  /** `Page.captureScreenshot.captureBeyondViewport`. Default false. */
  full?: boolean
  /** Image format. Default png. */
  format?: 'png' | 'jpeg'
}

export interface ScreenshotResult {
  base64: string
  format: 'png' | 'jpeg'
  /** File path if `opts.path` was provided. */
  path?: string
}

export interface HttpGetResult {
  status: number
  headers: Record<string, string>
  body: string
}

/** Session handle. The single value passed to every helper. */
export interface CdpSession {
  /** Underlying chrome-remote-interface client. */
  client: CDP.Client
  /** WebSocket URL we connected to. */
  wsUrl: string
  /** Currently attached target id (page or iframe). */
  targetId: string
  /** CDP session id assigned via `Target.attachToTarget {flatten: true}`. */
  sessionId: string
  /** Buffer of recent CDP events captured by the event tap. Bounded ring. */
  events: Array<{
    method: string
    params: Record<string, unknown>
    sessionId: string | undefined
  }>
  /** Most recent JS dialog params, if a `Page.javascriptDialogOpening` was seen and not yet closed. */
  pendingDialog: PageDialog['dialog'] | null
  /** Detach + close the connection. Idempotent. */
  detach(): Promise<void>
  /** Switch the active session to a different target, enabling default domains. */
  attachTarget(targetId: string): Promise<string>
}

/** Options accepted by `attach()`. */
export interface AttachOptions {
  /** Browserbase / DevTools WebSocket URL (`ws://...`). */
  wsUrl: string
  /** Optional event-buffer size. Default 500 to mirror the Python daemon. */
  eventBufferSize?: number
}
