#!/usr/bin/env node
import { dirname, join } from "node:path";
import { BrowserSessionAuth, OAuthBearerAuth, type AuthProvider } from "./auth.js";
import { BrightspaceClient } from "./client.js";
import { defaultConfigPath, readConfig, resolveUserPath } from "./config.js";
import { downloadCourseContent } from "./content.js";
import { defaultCredentialsPath, readLoginCredentials } from "./credentials.js";
import { normalizeEvents } from "./normalize.js";
import {
  defaultSessionPath,
  markSessionValidated,
  readBrowserSession,
  removeBrowserSession,
  writeBrowserSession,
} from "./session.js";
import { diffEvents, readEventStore, writeEventStore } from "./store.js";
import type { AcademicEventKind, EventStore } from "./types.js";

type Args = Record<string, string | boolean>;

const VERSION = "0.1.0";
const KNOWN_COMMANDS = new Set([
  "help",
  "config-show",
  "logout",
  "credential-login",
  "stonybrook-login",
  "login",
  "session-status",
  "auth-check",
  "download-content",
  "sync",
]);
const BOOLEAN_OPTIONS = new Set(["help", "version", "all-courses", "show-mfa-code"]);
const KNOWN_OPTIONS = new Set([
  ...BOOLEAN_OPTIONS,
  "config",
  "profile",
  "base-url",
  "credentials-file",
  "curl-file",
  "cookie-env",
  "access-token-env",
  "session-file",
  "from",
  "to",
  "output",
  "course-ids",
  "max-files",
  "max-bytes",
]);

function parseArgs(values: string[]): { command: string; options: Args } {
  const first = values[0];
  const command = !first || first.startsWith("--") ? "help" : first;
  const rest = !first || first.startsWith("--") ? values : values.slice(1);
  const options: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!key || key.includes("=")) throw new Error(`Invalid option syntax: ${token}`);
    if (!KNOWN_OPTIONS.has(key)) throw new Error(`Unknown option: --${key}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: --${key}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function option(options: Args, name: string, fallback?: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : fallback;
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function isoBoundary(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(expanded);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

function positiveIntegerOption(
  options: Args,
  name: string,
  fallback?: number,
): number | undefined {
  const value = option(options, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseCourseIds(value: string): number[] {
  const courseIds = value.split(",").map((item) => Number(item.trim()));
  if (
    courseIds.length === 0 ||
    courseIds.some((courseId) => !Number.isSafeInteger(courseId) || courseId <= 0)
  ) {
    throw new Error("--course-ids must be a comma-separated list of positive integers");
  }
  return [...new Set(courseIds)];
}

function profileName(options: Args): string | undefined {
  const profile = option(options, "profile");
  if (!profile) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || profile.includes("..")) {
    throw new Error("--profile must use 1-64 letters, digits, dots, underscores, or hyphens");
  }
  return profile;
}

interface ResolvedAuth {
  auth: AuthProvider;
  source: "oauth-environment" | "cookie-environment" | "curl-file" | "stored-session";
  storedSessionPath?: string;
}

async function createExplicitAuth(options: Args): Promise<ResolvedAuth | null> {
  const accessTokenEnv = option(options, "access-token-env");
  if (accessTokenEnv) {
    const token = process.env[accessTokenEnv];
    if (!token) throw new Error(`Environment variable ${accessTokenEnv} is empty`);
    return { auth: new OAuthBearerAuth(token), source: "oauth-environment" };
  }

  const curlFile = option(options, "curl-file");
  if (curlFile) {
    return { auth: await BrowserSessionAuth.fromFile(resolveUserPath(curlFile)), source: "curl-file" };
  }

  const cookieEnv = option(options, "cookie-env", "BRIGHTSPACE_COOKIE");
  const cookie = cookieEnv ? process.env[cookieEnv] : undefined;
  if (cookie) {
    return { auth: BrowserSessionAuth.fromText(cookie), source: "cookie-environment" };
  }

  return null;
}

async function createAuth(
  options: Args,
  baseUrl: string,
  sessionPath: string,
): Promise<ResolvedAuth> {
  const explicit = await createExplicitAuth(options);
  if (explicit) return explicit;

  try {
    const stored = await readBrowserSession(sessionPath, baseUrl);
    return { auth: stored.auth, source: "stored-session", storedSessionPath: sessionPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No stored Brightspace session. Run login first or provide --curl-file. Expected: ${sessionPath}`,
      );
    }
    throw error;
  }
}

function usage(): void {
  console.log(`brightspace-sync

Usage:
  brightspace-sync stonybrook-login
  brightspace-sync login --curl-file /private/path/request.curl
  brightspace-sync session-status
  brightspace-sync sync [options]
  brightspace-sync download-content --course-ids ID[,ID] [options]
  brightspace-sync logout
  brightspace-sync config-show

Configuration:
  --config PATH              Default: ~/.config/brightspace-sync/config.json
  --base-url URL             Brightspace HTTPS origin; config/env may supply it
  --profile NAME             Isolate session and output paths for one agent/account
  Environment variables: BRIGHTSPACE_CONFIG_FILE, BRIGHTSPACE_BASE_URL,
                         BRIGHTSPACE_SESSION_FILE, BRIGHTSPACE_CREDENTIALS_FILE

Authentication:
  stonybrook-login           Optional Stony Brook SSO + Duo browser adapter
  --show-mfa-code            Explicitly display a Verified Push matching code on stderr
  --credentials-file PATH    Default: ~/.config/brightspace-sync/credentials.json
  --curl-file PATH           Read an exported authenticated curl request; only D2L cookies are used
  --cookie-env NAME          Read a Cookie header from an environment variable (default: BRIGHTSPACE_COOKIE)
  --access-token-env NAME    Read an OAuth bearer token from an environment variable
  --session-file PATH        Override the protected session store path

Sync options:
  --from DATE_OR_ISO         Default: current time minus one day
  --to DATE_OR_ISO           Default: current time plus 180 days
  --output PATH              Default: data/events.json
  --course-ids CSV           Override automatic course discovery

Content download options:
  --course-ids CSV           Download selected accessible course offerings
  --all-courses              Download every accessible course offering
  --output PATH              Default: data/content
  --max-files COUNT          Limit files per course for a safe trial run
  --max-bytes BYTES          Per-file limit; default: 104857600 (100 MiB)
`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.version) {
    console.log(VERSION);
    return;
  }
  if (command === "help" || options.help) {
    usage();
    return;
  }
  if (!KNOWN_COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const profile = profileName(options);

  const configPath = resolveUserPath(
    option(options, "config", environmentValue("BRIGHTSPACE_CONFIG_FILE") ?? defaultConfigPath())!,
  );
  const config = await readConfig(configPath);
  const configuredSessionPath =
    option(options, "session-file") ??
    environmentValue("BRIGHTSPACE_SESSION_FILE") ??
    (profile
      ? join(dirname(defaultSessionPath()), "profiles", profile, "session.json")
      : config.sessionFile ?? defaultSessionPath());
  const sessionPath = resolveUserPath(configuredSessionPath);

  if (command === "config-show") {
    console.log(JSON.stringify({ ok: true, configFile: configPath, config }, null, 2));
    return;
  }

  if (command === "logout") {
    const removed = await removeBrowserSession(sessionPath);
    console.log(JSON.stringify({ ok: true, removed, sessionFile: sessionPath }, null, 2));
    return;
  }

  let baseUrl =
    option(options, "base-url") ?? environmentValue("BRIGHTSPACE_BASE_URL") ?? config.baseUrl;
  if (!baseUrl) {
    try {
      baseUrl = (await readBrowserSession(sessionPath)).metadata.baseUrl;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!baseUrl) {
    throw new Error(
      `Brightspace base URL is required. Set --base-url, BRIGHTSPACE_BASE_URL, or ${configPath}`,
    );
  }

  if (command === "credential-login" || command === "stonybrook-login") {
    const credentialsFile = resolveUserPath(
      option(
        options,
        "credentials-file",
        environmentValue("BRIGHTSPACE_CREDENTIALS_FILE") ??
          config.credentialsFile ??
          defaultCredentialsPath(),
      )!,
    );
    const credentials = await readLoginCredentials(credentialsFile);
    let loginWithStonyBrookPassword: typeof import("./password-login.js").loginWithStonyBrookPassword;
    try {
      ({ loginWithStonyBrookPassword } = await import("./password-login.js"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "Stony Brook login requires the optional playwright dependency; reinstall without --omit=optional",
        );
      }
      throw error;
    }
    const showMfaCode = options["show-mfa-code"] === true;
    const auth = await loginWithStonyBrookPassword({
      baseUrl,
      credentials,
      emit: (event) => console.error(JSON.stringify(event)),
      ...(showMfaCode
        ? {
            displayVerifiedPushCode: (code: string) =>
              console.error(`Verified Push matching code: ${code}`),
          }
        : {}),
    });
    const client = new BrightspaceClient({ baseUrl, auth });
    const versions = await client.discoverVersions();
    const enrollments = await client.getMyCourseOfferings(versions.lp);
    const saved = await writeBrowserSession(sessionPath, baseUrl, auth);
    console.log(
      JSON.stringify(
        {
          ok: true,
          authentication: "password-plus-mfa",
          versions,
          accessibleCourseOfferings: enrollments.length,
          session: saved,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "login") {
    const explicit = await createExplicitAuth(options);
    if (!explicit || !(explicit.auth instanceof BrowserSessionAuth)) {
      throw new Error("Login requires a browser session supplied with --curl-file or BRIGHTSPACE_COOKIE");
    }
    const client = new BrightspaceClient({ baseUrl, auth: explicit.auth });
    const versions = await client.discoverVersions();
    const enrollments = await client.getMyCourseOfferings(versions.lp);
    const saved = await writeBrowserSession(sessionPath, baseUrl, explicit.auth);
    console.log(
      JSON.stringify(
        {
          ok: true,
          authentication: "browser-session",
          source: explicit.source,
          versions,
          accessibleCourseOfferings: enrollments.length,
          session: saved,
        },
        null,
        2,
      ),
    );
    return;
  }

  const resolvedAuth =
    command === "session-status"
      ? await (async (): Promise<ResolvedAuth> => {
          const stored = await readBrowserSession(sessionPath, baseUrl);
          return { auth: stored.auth, source: "stored-session", storedSessionPath: sessionPath };
        })()
      : await createAuth(options, baseUrl, sessionPath);
  const client = new BrightspaceClient({ baseUrl, auth: resolvedAuth.auth });
  const versions = await client.discoverVersions();
  const enrollments = await client.getMyCourseOfferings(versions.lp);

  if (resolvedAuth.storedSessionPath) {
    await markSessionValidated(resolvedAuth.storedSessionPath);
  }

  if (command === "auth-check" || command === "session-status") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          authentication: resolvedAuth.auth.kind,
          source: resolvedAuth.source,
          versions,
          accessibleCourseOfferings: enrollments.length,
          ...(resolvedAuth.storedSessionPath
            ? { sessionFile: resolvedAuth.storedSessionPath }
            : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "download-content") {
    const courseIdsValue = option(options, "course-ids");
    const allCourses = options["all-courses"] === true;
    if (!courseIdsValue && !allCourses) {
      throw new Error("download-content requires --course-ids CSV or --all-courses");
    }
    if (courseIdsValue && allCourses) {
      throw new Error("Use either --course-ids CSV or --all-courses, not both");
    }

    const requestedCourseIds = courseIdsValue
      ? parseCourseIds(courseIdsValue)
      : enrollments.map((item) => item.OrgUnit.Id);
    const enrollmentById = new Map(enrollments.map((item) => [item.OrgUnit.Id, item]));
    const inaccessible = requestedCourseIds.filter((courseId) => !enrollmentById.has(courseId));
    if (inaccessible.length > 0) {
      throw new Error(`Course offerings are not accessible: ${inaccessible.join(", ")}`);
    }

    const contentOutput = option(options, "output") ??
      (profile ? join("data", "profiles", profile, "content") : config.contentOutput ?? "data/content");
    const outputRoot = resolveUserPath(contentOutput);
    const maxBytes = positiveIntegerOption(options, "max-bytes", 100 * 1024 * 1024)!;
    const maxFiles = positiveIntegerOption(options, "max-files");
    const summaries = [];
    for (const courseId of requestedCourseIds) {
      const enrollment = enrollmentById.get(courseId)!;
      const toc = await client.getContentToc(versions.le, courseId);
      summaries.push(
        await downloadCourseContent(
          client,
          versions.le,
          {
            id: courseId,
            code: enrollment.OrgUnit.Code,
            name: enrollment.OrgUnit.Name,
          },
          toc,
          {
            outputRoot,
            maxBytes,
            ...(maxFiles === undefined ? {} : { maxFiles }),
          },
        ),
      );
    }

    const totals = summaries.reduce(
      (sum, item) => ({
        fileTopics: sum.fileTopics + item.fileTopics,
        selectedFiles: sum.selectedFiles + item.selectedFiles,
        downloaded: sum.downloaded + item.downloaded,
        updated: sum.updated + item.updated,
        unchanged: sum.unchanged + item.unchanged,
        skippedUnavailable: sum.skippedUnavailable + item.skippedUnavailable,
        failed: sum.failed + item.failed,
      }),
      {
        fileTopics: 0,
        selectedFiles: 0,
        downloaded: 0,
        updated: 0,
        unchanged: 0,
        skippedUnavailable: 0,
        failed: 0,
      },
    );

    console.log(
      JSON.stringify(
        {
          ok: totals.failed === 0,
          authentication: resolvedAuth.auth.kind,
          source: resolvedAuth.source,
          versions,
          courses: summaries.length,
          totals,
          outputRoot,
          results: summaries,
        },
        null,
        2,
      ),
    );
    if (totals.failed > 0) process.exitCode = 1;
    return;
  }

  if (command !== "sync") {
    usage();
    throw new Error(`Unknown command: ${command}`);
  }

  const now = new Date();
  const defaultFrom = new Date(now.valueOf() - 24 * 60 * 60 * 1000);
  const defaultTo = new Date(now.valueOf() + 180 * 24 * 60 * 60 * 1000);
  const from = isoBoundary(option(options, "from"), defaultFrom);
  const to = isoBoundary(option(options, "to"), defaultTo);
  if (new Date(from) >= new Date(to)) throw new Error("--from must be earlier than --to");

  const courseIdsOverride = option(options, "course-ids");
  const courseIds = courseIdsOverride
    ? parseCourseIds(courseIdsOverride)
    : enrollments.map((item) => item.OrgUnit.Id);
  if (courseIds.length === 0) throw new Error("No accessible course offerings were found");

  const events = await client.getMyEvents(versions.le, {
    orgUnitIds: courseIds,
    from,
    to,
    association: 1,
  });
  const normalized = normalizeEvents(events);
  const eventOutput = option(options, "output") ??
    (profile ? join("data", "profiles", profile, "events.json") : config.eventOutput ?? "data/events.json");
  const output = resolveUserPath(eventOutput);
  const previous = await readEventStore(output);
  const diff = diffEvents(previous?.events ?? [], normalized);
  const store: EventStore = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { baseUrl: client.baseUrl.origin, from, to },
    events: normalized,
  };
  await writeEventStore(output, store);

  const kinds = normalized.reduce<Record<string, number>>((counts, event) => {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    return counts;
  }, {});
  const academicKinds = new Set<AcademicEventKind>(["assignment", "quiz", "exam", "project", "lab"]);
  const actionable = normalized.filter((event) => academicKinds.has(event.kind)).length;

  console.log(
    JSON.stringify(
      {
        ok: true,
        authentication: resolvedAuth.auth.kind,
        source: resolvedAuth.source,
        versions,
        accessibleCourseOfferings: enrollments.length,
        queriedCourseOfferings: courseIds.length,
        events: normalized.length,
        actionable,
        kinds,
        changes: {
          added: diff.added.length,
          updated: diff.updated.length,
          removed: diff.removed.length,
          unchanged: diff.unchanged,
        },
        output,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
});
