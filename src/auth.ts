import { readFile } from "node:fs/promises";

export interface AuthProvider {
  readonly kind: "browser-session" | "oauth-bearer";
  getHeaders(): Promise<Record<string, string>>;
}

const ALLOWED_D2L_COOKIES = new Set([
  "d2lSecureSessionVal",
  "d2lSessionVal",
  "d2lSameSiteCanaryA",
  "d2lSameSiteCanaryB",
]);

function unwrapCookieInput(input: string): string {
  const curlMatch = input.match(/(?:^|\s)-H\s+(['"])Cookie:\s*([\s\S]*?)\1/i);
  if (curlMatch?.[2]) return curlMatch[2];

  const headerMatch = input.match(/(?:^|\r?\n)Cookie:\s*([^\r\n]+)/i);
  if (headerMatch?.[1]) return headerMatch[1];

  return input.trim();
}

/**
 * Extract only the cookies needed for authenticated Brightspace GET requests.
 * Unrelated SSO, PeopleSoft, analytics, and Cloudflare cookies are discarded.
 */
export function extractD2LCookieHeader(input: string): string {
  const raw = unwrapCookieInput(input);
  const selected: string[] = [];

  for (const segment of raw.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!ALLOWED_D2L_COOKIES.has(name) || !value) continue;
    if (/\r|\n/.test(value)) throw new Error("Cookie value contains an invalid newline");
    selected.push(`${name}=${value}`);
  }

  const names = new Set(selected.map((entry) => entry.slice(0, entry.indexOf("="))));
  if (!names.has("d2lSecureSessionVal") || !names.has("d2lSessionVal")) {
    throw new Error(
      "The browser session is missing d2lSecureSessionVal or d2lSessionVal. Export a fresh authenticated Brightspace request.",
    );
  }

  return selected.join("; ");
}

export class BrowserSessionAuth implements AuthProvider {
  readonly kind = "browser-session" as const;

  constructor(private readonly cookieHeader: string) {}

  static fromText(input: string): BrowserSessionAuth {
    return new BrowserSessionAuth(extractD2LCookieHeader(input));
  }

  static async fromFile(path: string): Promise<BrowserSessionAuth> {
    return BrowserSessionAuth.fromText(await readFile(path, "utf8"));
  }

  async getHeaders(): Promise<Record<string, string>> {
    return { Cookie: this.cookieHeader };
  }

  /** Sensitive: use only when writing the protected local session store. */
  exportCookieHeader(): string {
    return this.cookieHeader;
  }
}

export class OAuthBearerAuth implements AuthProvider {
  readonly kind = "oauth-bearer" as const;

  constructor(private readonly accessToken: string) {
    if (!accessToken.trim()) throw new Error("OAuth access token is empty");
    if (/\r|\n/.test(accessToken)) throw new Error("OAuth access token contains an invalid newline");
  }

  async getHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}
