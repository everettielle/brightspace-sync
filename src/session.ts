import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserSessionAuth } from "./auth.js";
import { normalizeBrightspaceOrigin } from "./origin.js";

export interface StoredBrowserSession {
  schemaVersion: 1;
  baseUrl: string;
  createdAt: string;
  lastValidatedAt: string;
  cookieHeader: string;
}

export interface SessionMetadata {
  path: string;
  baseUrl: string;
  createdAt: string;
  lastValidatedAt: string;
}

function normalizedOrigin(baseUrl: string): string {
  return normalizeBrightspaceOrigin(baseUrl);
}

export function defaultSessionPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  const root = configHome ? resolve(configHome) : join(homedir(), ".config");
  return join(root, "brightspace-sync", "session.json");
}

async function enforcePrivatePermissions(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to use an insecure session file (${(info.mode & 0o777).toString(8)}). Run: chmod 600 ${path}`,
    );
  }
}

export async function writeBrowserSession(
  path: string,
  baseUrl: string,
  auth: BrowserSessionAuth,
): Promise<SessionMetadata> {
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const now = new Date().toISOString();
  const record: StoredBrowserSession = {
    schemaVersion: 1,
    baseUrl: normalizedOrigin(baseUrl),
    createdAt: now,
    lastValidatedAt: now,
    cookieHeader: auth.exportCookieHeader(),
  };
  const temporary = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, absolutePath);
  if (process.platform !== "win32") await chmod(absolutePath, 0o600);
  return metadata(absolutePath, record);
}

function validateRecord(value: unknown, path: string): StoredBrowserSession {
  if (!value || typeof value !== "object") throw new Error(`Invalid session file: ${path}`);
  const record = value as Partial<StoredBrowserSession>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.baseUrl !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.lastValidatedAt !== "string" ||
    typeof record.cookieHeader !== "string"
  ) {
    throw new Error(`Unsupported or malformed session file: ${path}`);
  }
  BrowserSessionAuth.fromText(record.cookieHeader);
  return record as StoredBrowserSession;
}

function metadata(path: string, record: StoredBrowserSession): SessionMetadata {
  return {
    path,
    baseUrl: record.baseUrl,
    createdAt: record.createdAt,
    lastValidatedAt: record.lastValidatedAt,
  };
}

export async function readBrowserSession(
  path: string,
  expectedBaseUrl?: string,
): Promise<{ auth: BrowserSessionAuth; metadata: SessionMetadata }> {
  const absolutePath = resolve(path);
  await enforcePrivatePermissions(absolutePath);
  const record = validateRecord(JSON.parse(await readFile(absolutePath, "utf8")) as unknown, absolutePath);
  if (expectedBaseUrl && record.baseUrl !== normalizedOrigin(expectedBaseUrl)) {
    throw new Error(
      `Stored session belongs to ${record.baseUrl}, not ${normalizedOrigin(expectedBaseUrl)}`,
    );
  }
  return {
    auth: BrowserSessionAuth.fromText(record.cookieHeader),
    metadata: metadata(absolutePath, record),
  };
}

export async function markSessionValidated(path: string): Promise<SessionMetadata> {
  const absolutePath = resolve(path);
  await enforcePrivatePermissions(absolutePath);
  const record = validateRecord(JSON.parse(await readFile(absolutePath, "utf8")) as unknown, absolutePath);
  record.lastValidatedAt = new Date().toISOString();
  const temporary = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, absolutePath);
  if (process.platform !== "win32") await chmod(absolutePath, 0o600);
  return metadata(absolutePath, record);
}

export async function removeBrowserSession(path: string): Promise<boolean> {
  try {
    await unlink(resolve(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
