import assert from "node:assert/strict";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserSessionAuth } from "../auth.js";
import {
  readBrowserSession,
  removeBrowserSession,
  writeBrowserSession,
} from "../session.js";

const COOKIE = "d2lSecureSessionVal=secure; d2lSessionVal=session; d2lSameSiteCanaryA=1";

test("writes and reads a protected browser session", async () => {
  const root = await mkdtemp(join(tmpdir(), "brightspace-session-test-"));
  const path = join(root, "nested", "session.json");
  const saved = await writeBrowserSession(
    path,
    "https://example.edu/d2l/home",
    BrowserSessionAuth.fromText(COOKIE),
  );
  assert.equal(saved.baseUrl, "https://example.edu");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "nested"))).mode & 0o777, 0o700);
  }
  const loaded = await readBrowserSession(path, "https://example.edu");
  assert.equal(loaded.auth.kind, "browser-session");
  assert.equal(loaded.metadata.path, path);
  assert.equal(await removeBrowserSession(path), true);
  assert.equal(await removeBrowserSession(path), false);
});

test("rejects a session file readable by other users", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode check is not available on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "brightspace-session-mode-test-"));
  const path = join(root, "session.json");
  await writeBrowserSession(path, "https://example.edu", BrowserSessionAuth.fromText(COOKIE));
  await chmod(path, 0o644);
  await assert.rejects(readBrowserSession(path), /insecure session file/);
});
