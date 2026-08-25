import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLoginCredentials } from "../credentials.js";

test("reads credentials only from a private file", async () => {
  const root = await mkdtemp(join(tmpdir(), "brightspace-credentials-test-"));
  const path = join(root, "credentials.json");
  await writeFile(path, JSON.stringify({ username: "student", password: "placeholder-value" }), {
    mode: 0o600,
  });
  const credentials = await readLoginCredentials(path);
  assert.equal(credentials.username, "student");
  assert.equal(credentials.password.length > 0, true);
});

test("rejects credentials readable by other users", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode check is not available on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "brightspace-credentials-mode-test-"));
  const path = join(root, "credentials.json");
  await writeFile(path, JSON.stringify({ username: "student", password: "placeholder-value" }), {
    mode: 0o600,
  });
  await chmod(path, 0o644);
  await assert.rejects(readLoginCredentials(path), /insecure credential file/);
});
