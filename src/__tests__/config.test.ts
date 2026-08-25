import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfigPath, readConfig, resolveUserPath } from "../config.js";

test("uses XDG_CONFIG_HOME for the default reusable config path", () => {
  assert.equal(
    defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/example-config" }),
    "/tmp/example-config/brightspace-sync/config.json",
  );
});

test("expands home-relative paths without embedding a user-specific directory", () => {
  assert.equal(resolveUserPath("~/private/session.json", "/home/example"), "/home/example/private/session.json");
});

test("returns an empty config when the optional file is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "brightspace-config-missing-"));
  assert.deepEqual(await readConfig(join(root, "missing.json")), {});
});

test("reads safe non-secret settings and rejects unknown keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "brightspace-config-test-"));
  const valid = join(root, "valid.json");
  await writeFile(
    valid,
    JSON.stringify({
      baseUrl: "https://lms.example.edu",
      sessionFile: "/private/session.json",
      eventOutput: "data/events.json",
    }),
  );
  assert.deepEqual(await readConfig(valid), {
    baseUrl: "https://lms.example.edu",
    sessionFile: "/private/session.json",
    eventOutput: "data/events.json",
  });

  const invalid = join(root, "invalid.json");
  await writeFile(invalid, JSON.stringify({ password: "must-not-live-here" }));
  await assert.rejects(readConfig(invalid), /Unsupported Brightspace config key: password/);
});

test("requires HTTPS Brightspace origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "brightspace-config-http-test-"));
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ baseUrl: "http://lms.example.edu" }));
  await assert.rejects(readConfig(path), /must use HTTPS/);
});
