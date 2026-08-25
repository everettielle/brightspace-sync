import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeBrightspaceOrigin } from "./origin.js";

export interface BrightspaceConfig {
  baseUrl?: string;
  sessionFile?: string;
  credentialsFile?: string;
  eventOutput?: string;
  contentOutput?: string;
}

const ALLOWED_KEYS = new Set<keyof BrightspaceConfig>([
  "baseUrl",
  "sessionFile",
  "credentialsFile",
  "eventOutput",
  "contentOutput",
]);

function configRoot(environment: NodeJS.ProcessEnv): string {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  return configHome ? resolve(configHome) : join(homedir(), ".config");
}

export function defaultConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(configRoot(environment), "brightspace-sync", "config.json");
}

export function resolveUserPath(value: string, home = homedir()): string {
  if (value === "~") return resolve(home);
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return resolve(value);
}

function validateConfig(value: unknown, path: string): BrightspaceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Brightspace config must be a JSON object: ${path}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key as keyof BrightspaceConfig)) {
      throw new Error(`Unsupported Brightspace config key: ${key}`);
    }
    const setting = record[key];
    if (typeof setting !== "string" || !setting.trim()) {
      throw new Error(`Brightspace config value must be a non-empty string: ${key}`);
    }
  }
  if (typeof record.baseUrl === "string") {
    record.baseUrl = normalizeBrightspaceOrigin(record.baseUrl);
  }
  return record as BrightspaceConfig;
}

export async function readConfig(path: string): Promise<BrightspaceConfig> {
  const absolutePath = resolve(path);
  try {
    return validateConfig(JSON.parse(await readFile(absolutePath, "utf8")) as unknown, absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
