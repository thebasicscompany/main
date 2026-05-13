import { describe, expect, it } from "vitest";
import {
  sendEmailApproval,
  sendSmsApproval,
  composioCallApproval,
  bashApproval,
  APPROVAL_TTL_DEFAULT_S,
  APPROVAL_TTL_SMS_S,
} from "./policy.js";

describe("sendEmailApproval", () => {
  it("does NOT require approval for a single recipient", () => {
    expect(sendEmailApproval({ to: "alice@x.com" }).required).toBe(false);
    expect(sendEmailApproval({ to: ["alice@x.com"] }).required).toBe(false);
  });

  it("requires approval for 2+ recipients (multi-recipient blast)", () => {
    const d = sendEmailApproval({ to: ["a@x.com", "b@x.com"] });
    expect(d.required).toBe(true);
    expect(d.reason).toContain("2 recipients");
    expect(d.expiresInSeconds).toBe(APPROVAL_TTL_DEFAULT_S);
  });

  it("requires approval for many recipients", () => {
    const d = sendEmailApproval({
      to: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
    });
    expect(d.required).toBe(true);
    expect(d.reason).toContain("4 recipients");
  });
});

describe("sendSmsApproval", () => {
  it("ALWAYS requires approval, with 30-minute TTL", () => {
    const d = sendSmsApproval({ to: "+15551234567", body: "hi" });
    expect(d.required).toBe(true);
    expect(d.expiresInSeconds).toBe(APPROVAL_TTL_SMS_S);
    expect(d.reason).toBe("send_sms (always)");
  });
});

describe("composioCallApproval", () => {
  it.each<[string, boolean]>([
    ["GMAIL_DELETE_THREAD",     true],
    ["GMAIL_SEND_EMAIL",        true],
    ["GMAIL_CREATE_LABEL",      true],
    ["GMAIL_UPDATE_DRAFT",      true],
    ["GMAIL_MODIFY_EMAIL",      true],
    ["GMAIL_REMOVE_LABEL",      true],
    ["GMAIL_LIST_THREADS",      false],
    ["GMAIL_FETCH_EMAILS",      false],
    ["GMAIL_GET_THREAD",        false],
  ])("toolSlug=%s requires approval=%s", (slug, required) => {
    const d = composioCallApproval({ toolSlug: slug });
    expect(d.required).toBe(required);
    if (required) {
      expect(d.reason).toContain(slug);
      expect(d.expiresInSeconds).toBe(APPROVAL_TTL_DEFAULT_S);
    }
  });
});

describe("bashApproval", () => {
  it.each([
    ["rm -rf /tmp/x",                              true],
    ["  rm -rf /workspace/cache",                  true],
    ["mv old.txt new.txt",                         true],
    ["chmod 777 /opt/secrets",                     true],
    ["chown www-data:www-data /var/log",           true],
    ["dd if=/dev/zero of=/dev/sda",                true],
    ["mkfs.ext4 /dev/sda1",                        true],
    ["ls -la",                                     false],
    ["echo hi",                                    false],
    ["cat file.txt",                               false],
    ["rm file.txt",                                false],     // rm without -rf is NOT in the destructive set
    ["chmod 644 file.txt",                         false],     // chmod with non-777 mode is fine
  ])("cmd=%s → required=%s", (cmd, required) => {
    expect(bashApproval({ cmd }).required).toBe(required);
  });
});
