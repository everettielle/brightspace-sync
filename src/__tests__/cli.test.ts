import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../cli.js", import.meta.url);

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, BRIGHTSPACE_CONFIG_FILE: "/definitely/missing/config.json" },
  });
}

test("prints a stable version without reading configuration or contacting Brightspace", () => {
  const result = run("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "0.1.0");
  assert.equal(result.stderr, "");
});

test("rejects unknown commands before authentication", () => {
  const result = run("unknown-command");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: unknown-command/);
});

test("rejects unknown, duplicate, and missing-value options", () => {
  assert.match(run("help", "--unknown").stderr, /Unknown option: --unknown/);
  assert.match(
    run("help", "--config", "a", "--config", "b").stderr,
    /Duplicate option: --config/,
  );
  assert.match(run("help", "--config").stderr, /Missing value for --config/);
});
