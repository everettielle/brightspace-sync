import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { BrowserSessionAuth } from "./auth.js";
import type { LoginCredentials } from "./credentials.js";
import { normalizeBrightspaceOrigin } from "./origin.js";

export interface PasswordLoginOptions {
  baseUrl: string;
  credentials: LoginCredentials;
  headless?: boolean;
  timeoutMs?: number;
  emit?: (event: PasswordLoginEvent) => void;
  requestMfaCode?: () => Promise<string>;
  displayVerifiedPushCode?: (code: string) => void;
}

export type PasswordLoginEvent =
  | { event: "browser_started" }
  | { event: "password_submitted" }
  | {
      event: "mfa_required";
      mode: "push" | "verified_push" | "passcode" | "unknown";
    }
  | { event: "push_sent" }
  | { event: "authenticated" };

const D2L_COOKIE_NAMES = new Set([
  "d2lSecureSessionVal",
  "d2lSessionVal",
  "d2lSameSiteCanaryA",
  "d2lSameSiteCanaryB",
]);

function cleanOrigin(baseUrl: string): string {
  return normalizeBrightspaceOrigin(baseUrl);
}

async function visible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

async function bodyText(frame: Frame): Promise<string> {
  try {
    return (await frame.locator("body").innerText({ timeout: 1_000 })).toLowerCase();
  } catch {
    return "";
  }
}

async function findVisibleInFrames(page: Page, selector: string): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const locator = frame.locator(selector);
    if (await visible(locator)) return locator.first();
  }
  return null;
}

async function findButtonInFrames(page: Page, pattern: RegExp): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const button = frame.getByRole("button", { name: pattern });
    if (await visible(button)) return button.first();
    const link = frame.getByRole("link", { name: pattern });
    if (await visible(link)) return link.first();
  }
  return null;
}

async function d2lAuth(context: BrowserContext, baseUrl: string): Promise<BrowserSessionAuth | null> {
  const hostname = new URL(cleanOrigin(baseUrl)).hostname;
  const cookies = await context.cookies();
  const selected = cookies
    .filter(
      (cookie) =>
        D2L_COOKIE_NAMES.has(cookie.name) &&
        (cookie.domain === hostname || hostname.endsWith(cookie.domain.replace(/^\./, "."))),
    )
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  try {
    return BrowserSessionAuth.fromText(selected);
  } catch {
    return null;
  }
}

async function pageHasLoginError(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const text = await bodyText(frame);
    if (/incorrect|invalid credentials|authentication failed|login failed|account.*locked/.test(text)) {
      return true;
    }
  }
  return false;
}

export function classifyMfaState(input: {
  text: string;
  hasPasscodeInput: boolean;
  hasPushButton: boolean;
}): "push" | "verified_push" | "passcode" | "unknown" | null {
  const text = input.text.toLowerCase();
  if (extractVerifiedPushCode(text)) return "verified_push";
  if (input.hasPasscodeInput || /enter.*passcode|verification code|one-time code/.test(text)) {
    return "passcode";
  }
  if (
    input.hasPushButton ||
    /duo push|push notification|check.*(phone|device)|approve.*(login|request)|request.*waiting/.test(text)
  ) {
    return "push";
  }
  if (/duo|two-step|two.factor|multi.factor|mfa/.test(text)) return "unknown";
  return null;
}

export function extractVerifiedPushCode(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  if (!/duo|push|mobile/.test(normalized)) return null;
  if (!/code|enter|type|shown|displayed|verify/.test(normalized)) return null;

  const contextualPatterns = [
    /(?:enter|type|use|select)\s+(?:the\s+)?(?:verification\s+)?code[^0-9]{0,80}\b(\d{3})\b/i,
    /\b(\d{3})\b[^a-z0-9]{0,40}(?:in|on)\s+(?:the\s+)?duo\s+mobile/i,
    /(?:code|shown|displayed)[^0-9]{0,40}\b(\d{3})\b/i,
  ];
  for (const pattern of contextualPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1];
  }

  const candidates = normalized.match(/\b\d{3}\b/g) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}

async function detectMfa(page: Page): Promise<{
  mode: "push" | "verified_push" | "passcode" | "unknown";
  code: string | null;
  pushButton: Locator | null;
  passcodeInput: Locator | null;
} | null> {
  const passcodeInput = await findVisibleInFrames(
    page,
    'input[autocomplete="one-time-code"], input[name*="passcode" i], input[id*="passcode" i], input[type="tel"]',
  );
  const pushButton = await findButtonInFrames(
    page,
    /send.*push|duo push|push notification|verify with.*push/i,
  );
  let text = "";
  for (const frame of page.frames()) text += `\n${await bodyText(frame)}`;
  const mode = classifyMfaState({
    text,
    hasPasscodeInput: Boolean(passcodeInput),
    hasPushButton: Boolean(pushButton),
  });
  return mode ? { mode, code: extractVerifiedPushCode(text), pushButton, passcodeInput } : null;
}

async function defaultMfaCodePrompt(): Promise<string> {
  throw new Error(
    "Passcode entry requires a caller-supplied requestMfaCode callback so the secret is not echoed",
  );
}

async function waitForAuthentication(
  context: BrowserContext,
  page: Page,
  baseUrl: string,
  timeoutMs: number,
): Promise<BrowserSessionAuth> {
  const deadline = Date.now() + timeoutMs;
  let lastContinuationClick = 0;
  let lastDebugCapture = 0;
  while (Date.now() < deadline) {
    const auth = await d2lAuth(context, baseUrl);
    if (auth) return auth;

    let combinedText = "";
    for (const frame of page.frames()) combinedText += `\n${await bodyText(frame)}`;
    if (/request.*(?:denied|expired)|verification failed|incorrect code|try again/.test(combinedText)) {
      throw new Error("Duo approval was denied, expired, or failed");
    }

    if (Date.now() - lastContinuationClick >= 1_000) {
      const continuation = await findButtonInFrames(
        page,
        /^(?:yes, this is my device|continue|yes, trust browser|trust browser|return to.*|log in)$/i,
      );
      if (continuation) {
        await continuation.click().catch(() => undefined);
        lastContinuationClick = Date.now();
      }
    }

    const debugDirectory = process.env.BRIGHTSPACE_LOGIN_DEBUG_DIR;
    if (debugDirectory && Date.now() - lastDebugCapture >= 10_000) {
      lastDebugCapture = Date.now();
      const directory = resolve(debugDirectory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const controls: string[] = [];
      for (const frame of page.frames()) {
        const items = await frame
          .locator('button, input[type="submit"], input[type="button"], a')
          .evaluateAll((elements) =>
            elements
              .filter((element) => {
                const style = window.getComputedStyle(element);
                const box = element.getBoundingClientRect();
                return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
              })
              .map((element) =>
                (element.getAttribute("aria-label") ||
                  element.getAttribute("value") ||
                  element.textContent ||
                  "")
                  .replace(/\s+/g, " ")
                  .trim(),
              )
              .filter(Boolean)
              .slice(0, 30),
          )
          .catch(() => [] as string[]);
        controls.push(...items);
      }
      const current = new URL(page.url());
      const cookieNames = (await context.cookies()).map((cookie) => cookie.name);
      const diagnosticPath = join(directory, "mfa-state.json");
      await writeFile(
        diagnosticPath,
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            page: `${current.origin}${current.pathname}`,
            frames: page.frames().map((frame) => {
              try {
                const url = new URL(frame.url());
                return `${url.origin}${url.pathname}`;
              } catch {
                return "unknown";
              }
            }),
            controls: [...new Set(controls)],
            d2lCookieNames: cookieNames.filter((name) => name.toLowerCase().includes("d2l")),
            state: {
              success: /success|verified|approved/.test(combinedText),
              waiting: /waiting|check your phone|open duo mobile/.test(combinedText),
              continue: /continue|trust browser|return to/.test(combinedText),
              failed: /denied|expired|failed|incorrect code|try again/.test(combinedText),
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await chmod(diagnosticPath, 0o600);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const cookieNames = (await context.cookies())
    .map((cookie) => cookie.name)
    .filter((name) => name.toLowerCase().includes("d2l"));
  let location = "unknown";
  try {
    const current = new URL(page.url());
    location = `${current.origin}${current.pathname}`;
  } catch {
    // Keep the diagnostic URL free of query parameters and fragments.
  }
  throw new Error(
    `Timed out waiting for Brightspace authentication (page: ${location}; D2L cookies: ${cookieNames.join(",") || "none"})`,
  );
}

export async function loginWithStonyBrookPassword(
  options: PasswordLoginOptions,
): Promise<BrowserSessionAuth> {
  const emit = options.emit ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const browser = await chromium.launch({ headless: options.headless ?? true });
  emit({ event: "browser_started" });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${cleanOrigin(options.baseUrl)}/d2l/login`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    const samlLink = page.locator('a[href*="/d2l/lp/auth/saml/initiate-login"]');
    await samlLink.first().waitFor({ state: "attached", timeout: 60_000 });
    await samlLink.first().click();

    await page.locator('input[name="j_username"], #username').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await page.locator('input[name="j_username"], #username').first().fill(options.credentials.username);
    await page.locator('input[name="j_password"], #password').first().fill(options.credentials.password);
    await page.getByRole("button", { name: /^login$/i }).click();
    emit({ event: "password_submitted" });

    const discoveryDeadline = Date.now() + timeoutMs;
    let pushTriggered = false;
    let lastMfaEvent = "";
    while (Date.now() < discoveryDeadline) {
      const auth = await d2lAuth(context, options.baseUrl);
      if (auth) {
        emit({ event: "authenticated" });
        return auth;
      }
      if (await pageHasLoginError(page)) {
        throw new Error("The identity provider rejected the username or password");
      }

      const mfa = await detectMfa(page);
      if (mfa) {
        const eventKey = `${mfa.mode}:${mfa.code ?? ""}`;
        if (eventKey !== lastMfaEvent) {
          emit({ event: "mfa_required", mode: mfa.mode });
          if (mfa.mode === "verified_push" && mfa.code) {
            if (!options.displayVerifiedPushCode) {
              throw new Error(
                "Verified Push requires an explicit displayVerifiedPushCode callback",
              );
            }
            options.displayVerifiedPushCode(mfa.code);
          }
          lastMfaEvent = eventKey;
        }
        if (mfa.mode === "push") {
          if (mfa.pushButton && !pushTriggered) {
            await mfa.pushButton.click();
            pushTriggered = true;
            emit({ event: "push_sent" });
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        } else if (mfa.mode === "verified_push") {
          const authenticated = await waitForAuthentication(context, page, options.baseUrl, timeoutMs);
          emit({ event: "authenticated" });
          return authenticated;
        } else if (mfa.mode === "passcode") {
          const code = await (options.requestMfaCode ?? defaultMfaCodePrompt)();
          if (!/^\d{4,10}$/.test(code)) throw new Error("MFA code must contain 4 to 10 digits");
          if (!mfa.passcodeInput) throw new Error("Duo requested a passcode but no input was found");
          await mfa.passcodeInput.fill(code);
          const verify = await findButtonInFrames(page, /verify|continue|log in|submit/i);
          if (verify) await verify.click();
        } else {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        const authenticated = await waitForAuthentication(context, page, options.baseUrl, timeoutMs);
        emit({ event: "authenticated" });
        return authenticated;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error("Could not identify the post-password login state");
  } finally {
    options.credentials.password = "";
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/** @deprecated Use loginWithStonyBrookPassword to make the institution-specific behavior explicit. */
export const loginWithPassword = loginWithStonyBrookPassword;
