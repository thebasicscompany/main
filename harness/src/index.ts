/**
 * @basics/harness — TypeScript port of the browser-harness Python CDP helpers.
 *
 * Public API: `attach`, `detach`, every snake_case helper from helpers.py,
 * and the shared types. The Python reference lives in
 * `runtime/harness/reference/python-original/` for line-by-line audit.
 */

export { attach, detach } from './session.js'
export {
  goto_url,
  page_info,
  click_at_xy,
  type_text,
  fill_input,
  press_key,
  scroll,
  capture_screenshot,
  list_tabs,
  current_tab,
  switch_tab,
  new_tab,
  ensure_real_tab,
  iframe_target,
  wait,
  wait_for_load,
  wait_for_element,
  wait_for_network_idle,
  js,
  dispatch_key,
  upload_file,
  http_get,
} from './helpers.js'
export type {
  AttachOptions,
  CdpSession,
  CurrentTabInfo,
  HttpGetResult,
  KeyModifiers,
  MouseButton,
  PageDialog,
  PageInfo,
  PageInfoResult,
  Point,
  ScreenshotOptions,
  ScreenshotResult,
  TabInfo,
} from './types.js'
export { Modifiers } from './types.js'

// Raw CDP escape hatch — wraps the internal `cdp()` so callers (worker
// tools, etc.) can issue arbitrary Chrome DevTools Protocol commands
// against the attached session. Browser-scoped calls (`Target.*`) skip
// the session id automatically.
export { cdp } from './internal.js'
