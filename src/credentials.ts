import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LoginCredentials {
  username: string;
  password: string;
}

export function defaultCredentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  const root = configHome ? resolve(configHome) : join(homedir(), ".config");
  return join(root, "brightspace-sync", "credentials.json");
}

export async function readLoginCredentials(path: string): Promise<LoginCredentials> {
  const absolutePath = resolve(path);
  const info = await stat(absolutePath);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to use an insecure credential file (${(info.mode & 0o777).toString(8)}). Run: chmod 600 ${absolutePath}`,
    );
  }

  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Credential file must be a JSON object");
  const value = parsed as Partial<LoginCredentials>;
  if (typeof value.username !== "string" || !value.username.trim()) {
    throw new Error("Credential file username is empty");
  }
  if (typeof value.password !== "string" || !value.password) {
    throw new Error("Credential file password is empty");
  }
  return { username: value.username.trim(), password: value.password };
}
