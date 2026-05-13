// E.3 — Heuristic sign-in wall detector.
//
// Pure function over a captured (text|html) blob + current URL. Used by the
// browser-harness tool integration to decide whether the navigation landed
// on a real page or a "log in to continue" gate. Two outcomes downstream:
//
//   gated + no saved storageState  → emit browser_login_required (run
//                                    returns structured error so the agent
//                                    doesn't try to scrape a login form)
//   gated + saved storageState     → emit browser_session_expired (the
//                                    saved state was rejected by the site;
//                                    the operator needs to reconnect)
//
// Heuristics are intentionally tight — false positives kill perfectly
// good public pages with the word "login" in the URL hash. We prefer false
// negatives (the agent will still hit the actual content and we miss the
// "early warning"); the detector is a hint, not a hard gate.

export interface DetectSignInWallResult {
  gated: boolean;
  /**
   * Which heuristic fired. `undefined` only when `gated=false`. Surfaced into
   * the `browser_login_required` event so live verify can confirm which
   * branch caught a real gate vs. a regression.
   */
  signal?: "url_path" | "text_phrase" | "form_marker";
}

// URL path tokens that almost always mean a sign-in screen. The match is
// case-insensitive AND boundary-aware (`/login` matches `/Login`, `/login`,
// `/login?next=…`; `/loginhint` does NOT match — there must be a `/` or `?`
// or end-of-string after the token).
const URL_PATH_PATTERNS: RegExp[] = [
  /\/login(\/|\?|$)/i,
  /\/signin(\/|\?|$)/i,
  /\/sign-in(\/|\?|$)/i,
  /\/signup(\/|\?|$)/i,
  /\/sign-up(\/|\?|$)/i,
  /\/auth\//i,
  /\/sso(\/|\?|$)/i,
  /\/oauth(\/|\?|$)/i,
];

// Phrase patterns matched anywhere in the captured page text or HTML.
// Each phrase is concrete enough that hitting it on a real article is rare;
// the false-positive risk on news / blog pages is low because the patterns
// require imperative phrasing ("please log in", "sign in to continue", etc.)
// rather than the bare word "login".
const TEXT_PHRASE_PATTERNS: RegExp[] = [
  /sign\s*in\s+to\s+continue/i,
  /sign\s*in\s+to\s+see/i,
  /please\s+log\s*in/i,
  /please\s+sign\s*in/i,
  /you\s+must\s+(log|sign)\s*in/i,
  /requires?\s+you\s+to\s+(log|sign)\s*in/i,
  /join\s+linkedin/i,
  /create\s+an\s+account\s+to\s+(view|see|continue)/i,
  /members\s+can\s+only/i,
  /log\s*in\s+to\s+your\s+account/i,
];

// HTML attribute / element markers that strongly imply a login form is
// rendered. `id=` / `name=` matches catch React-controlled inputs; the
// type=password and autocomplete=current-password markers catch nearly
// every well-formed login form regardless of framework.
const FORM_MARKER_PATTERNS: RegExp[] = [
  /<input[^>]+type\s*=\s*["']?password["']?/i,
  /autocomplete\s*=\s*["']current-password["']/i,
  /name\s*=\s*["']password["']/i,
];

/**
 * Run the heuristic chain in order. First match wins; later branches don't
 * run. The order is URL → text → form so that obvious cases (path-based
 * detection) are cheapest. The text and form regex banks both scan the
 * same blob, capped at the first 64 KB to bound work on huge HTML payloads.
 */
export function detectSignInWall(
  pageTextOrHtml: string | null | undefined,
  currentUrl: string | null | undefined,
): DetectSignInWallResult {
  if (currentUrl) {
    try {
      const u = new URL(currentUrl);
      const pathAndQuery = u.pathname + u.search;
      for (const pat of URL_PATH_PATTERNS) {
        if (pat.test(pathAndQuery)) {
          return { gated: true, signal: "url_path" };
        }
      }
    } catch {
      // unparseable URL — fall through to text/form scan
    }
  }

  if (typeof pageTextOrHtml === "string" && pageTextOrHtml.length > 0) {
    const blob = pageTextOrHtml.length > 65_536
      ? pageTextOrHtml.slice(0, 65_536)
      : pageTextOrHtml;

    for (const pat of TEXT_PHRASE_PATTERNS) {
      if (pat.test(blob)) return { gated: true, signal: "text_phrase" };
    }
    for (const pat of FORM_MARKER_PATTERNS) {
      if (pat.test(blob)) return { gated: true, signal: "form_marker" };
    }
  }

  return { gated: false };
}
