import assert from "node:assert/strict";
import test from "node:test";
import { classifyMfaState, extractVerifiedPushCode } from "../password-login.js";

test("detects Duo push approval pages", () => {
  assert.equal(
    classifyMfaState({
      text: "Check your phone. We sent a Duo Push notification.",
      hasPasscodeInput: false,
      hasPushButton: false,
    }),
    "push",
  );
});

test("prioritizes visible passcode inputs", () => {
  assert.equal(
    classifyMfaState({ text: "Duo Security", hasPasscodeInput: true, hasPushButton: true }),
    "passcode",
  );
});

test("detects Duo Verified Push and extracts its three-digit code", () => {
  const text = "Open Duo Mobile and enter the code shown to verify your identity: 277";
  assert.equal(extractVerifiedPushCode(text), "277");
  assert.equal(
    classifyMfaState({ text, hasPasscodeInput: false, hasPushButton: false }),
    "verified_push",
  );
});

test("does not treat unrelated numbers as a Verified Push code", () => {
  assert.equal(extractVerifiedPushCode("Brightspace course 311"), null);
});

test("returns null for ordinary pages", () => {
  assert.equal(
    classifyMfaState({ text: "Brightspace calendar", hasPasscodeInput: false, hasPushButton: false }),
    null,
  );
});
