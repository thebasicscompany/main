import { describe, expect, it } from "vitest";
import { detectSignInWall } from "./detector.js";

describe("detectSignInWall", () => {
  describe("URL-path branch (signal=url_path)", () => {
    it("matches /login", () => {
      expect(detectSignInWall("", "https://example.com/login")).toEqual({
        gated: true,
        signal: "url_path",
      });
    });
    it("matches /signin?next=...", () => {
      expect(
        detectSignInWall("", "https://example.com/signin?next=%2Fdash"),
      ).toEqual({ gated: true, signal: "url_path" });
    });
    it("matches /sign-in", () => {
      expect(detectSignInWall("", "https://example.com/sign-in")).toEqual({
        gated: true,
        signal: "url_path",
      });
    });
    it("matches /auth/", () => {
      expect(detectSignInWall("", "https://example.com/auth/callback")).toEqual({
        gated: true,
        signal: "url_path",
      });
    });
    it("matches /sso", () => {
      expect(detectSignInWall("", "https://example.com/sso")).toEqual({
        gated: true,
        signal: "url_path",
      });
    });
    it("is boundary-aware — /loginhint does NOT match", () => {
      expect(detectSignInWall("", "https://example.com/loginhint/abc")).toEqual({
        gated: false,
      });
    });
    it("ignores unparseable URLs and continues to text scan", () => {
      expect(detectSignInWall("normal body content", "not a url")).toEqual({
        gated: false,
      });
    });
  });

  describe("text-phrase branch (signal=text_phrase)", () => {
    it("matches 'Sign in to continue'", () => {
      expect(
        detectSignInWall(
          "<h1>LinkedIn</h1><p>Sign in to continue your job search.</p>",
          "https://www.linkedin.com/in/foo",
        ),
      ).toEqual({ gated: true, signal: "text_phrase" });
    });
    it("matches 'Please log in'", () => {
      expect(
        detectSignInWall(
          "Please log in to access this resource.",
          "https://example.com/dashboard",
        ),
      ).toEqual({ gated: true, signal: "text_phrase" });
    });
    it("matches 'Join LinkedIn'", () => {
      expect(
        detectSignInWall(
          "<h2>Join LinkedIn</h2><p>Welcome to the world's largest network.</p>",
          "https://www.linkedin.com/in/foo",
        ),
      ).toEqual({ gated: true, signal: "text_phrase" });
    });
    it("case-insensitive", () => {
      expect(
        detectSignInWall("PLEASE SIGN IN", "https://example.com/x"),
      ).toEqual({ gated: true, signal: "text_phrase" });
    });
    it("does NOT match a normal article that mentions 'login' once", () => {
      expect(
        detectSignInWall(
          "Our login system uses OAuth. Read more about authentication.",
          "https://example.com/blog/auth",
        ),
      ).toEqual({ gated: false });
    });
  });

  describe("form-marker branch (signal=form_marker)", () => {
    it("matches an explicit type=password input", () => {
      expect(
        detectSignInWall(
          '<form><input type="password" name="pwd" /></form>',
          "https://example.com/page",
        ),
      ).toEqual({ gated: true, signal: "form_marker" });
    });
    it("matches autocomplete=current-password", () => {
      expect(
        detectSignInWall(
          '<input autocomplete="current-password" />',
          "https://example.com/page",
        ),
      ).toEqual({ gated: true, signal: "form_marker" });
    });
  });

  describe("negative cases", () => {
    it("returns gated:false on a normal LP profile HTML", () => {
      const html =
        '<html><head><title>Satya Nadella | Microsoft CEO</title></head>' +
        '<body><h1>Satya Nadella</h1><p>Chief Executive Officer at Microsoft</p>' +
        '<p>Redmond, Washington, United States</p></body></html>';
      expect(
        detectSignInWall(html, "https://www.linkedin.com/in/satyanadella/"),
      ).toEqual({ gated: false });
    });
    it("handles null / undefined inputs without throwing", () => {
      expect(detectSignInWall(null, null)).toEqual({ gated: false });
      expect(detectSignInWall(undefined, undefined)).toEqual({ gated: false });
      expect(detectSignInWall("", "")).toEqual({ gated: false });
    });
  });

  describe("ordering — URL wins over text", () => {
    it("URL match short-circuits before text scan runs", () => {
      // Body has a text-phrase match too; ensure URL branch fires first
      // so signal='url_path' (cheaper).
      expect(
        detectSignInWall(
          "please log in",
          "https://example.com/login?next=%2Fhome",
        ),
      ).toEqual({ gated: true, signal: "url_path" });
    });
  });

  describe("size cap", () => {
    it("caps HTML scan at 64 KB to bound work on huge payloads", () => {
      // Pad junk to ~80 KB, with the magic phrase ONLY in the last chunk.
      // The detector should NOT find it (because the cap truncated it out).
      const filler = "x".repeat(70_000);
      const blob = filler + "please log in";
      expect(detectSignInWall(blob, "https://example.com/page")).toEqual({
        gated: false,
      });
    });
  });
});
