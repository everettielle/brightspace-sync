import assert from "node:assert/strict";
import test from "node:test";
import { extractD2LCookieHeader } from "../auth.js";

test("extracts only the minimum Brightspace session cookies from curl", () => {
  const curl = `curl 'https://example.edu/d2l/api/versions/' \\
    -H 'Cookie: analytics=discard; d2lSecureSessionVal=secure123; PS_TOKEN=discard; d2lSessionVal=session456; d2lSameSiteCanaryA=1'`;
  assert.equal(
    extractD2LCookieHeader(curl),
    "d2lSecureSessionVal=secure123; d2lSessionVal=session456; d2lSameSiteCanaryA=1",
  );
});

test("rejects an incomplete browser session", () => {
  assert.throws(
    () => extractD2LCookieHeader("d2lSessionVal=session-only"),
    /missing d2lSecureSessionVal or d2lSessionVal/,
  );
});
