import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBrightspaceOrigin } from "../origin.js";

test("normalizes Brightspace paths to a credential-free HTTPS origin", () => {
  assert.equal(
    normalizeBrightspaceOrigin("https://lms.example.edu/d2l/home"),
    "https://lms.example.edu",
  );
});

test("rejects credentials, query strings, fragments, and non-HTTPS origins", () => {
  assert.throws(
    () => normalizeBrightspaceOrigin("https://user:pass@lms.example.edu"),
    /must not contain a username or password/,
  );
  assert.throws(
    () => normalizeBrightspaceOrigin("https://lms.example.edu/?token=secret"),
    /query string or fragment/,
  );
  assert.throws(
    () => normalizeBrightspaceOrigin("https://lms.example.edu/#secret"),
    /query string or fragment/,
  );
  assert.throws(() => normalizeBrightspaceOrigin("http://lms.example.edu"), /must use HTTPS/);
});
