# Brightspace Sync

Read-only TypeScript library and CLI for Brightspace course events and course-content files.

The reusable core uses official Brightspace APIs. Authentication is pluggable:

- protected browser-session cookies imported from an authenticated request
- OAuth bearer tokens
- an optional Stony Brook SSO + Duo browser adapter
- custom `AuthProvider` implementations for other institutions

Browser automation is used only by the optional authentication adapter. Course discovery, calendar retrieval, content enumeration, and file downloads use Brightspace APIs.

## Features

- automatic LE and LP API-version discovery
- accessible course-offering discovery with pagination
- calendar-event collection, classification, normalization, and change detection
- recursive learner-visible content table-of-contents enumeration
- streaming downloads for Brightspace file topics
- atomic file writes, safe paths, size limits, and owner-only POSIX permissions
- per-course manifests containing source topic IDs, modification dates, sizes, and SHA-256 hashes
- unchanged-file reconciliation on repeated runs
- same-origin enforcement to prevent authenticated requests from following hostile URLs
- protected external session and credential files

All operations are read-only.

“Read-only” describes remote Brightspace operations. The CLI still writes local event stores,
downloaded course files, manifests, configuration, and protected sessions; `logout` deletes the
local session file.

## Requirements

- Node.js 22 or newer
- a Brightspace account with permission to access the requested courses
- Playwright/Chromium only when using the optional Stony Brook login adapter

## Install from a source checkout

```bash
npm ci
npm run check
npm link
```

`npm link` exposes the local CLI as `brightspace-sync`. It is optional; commands may also be run through `node dist/cli.js` or the provided npm scripts.

The package remains `private` and `UNLICENSED` until a public package name and license are deliberately selected.

## Configuration

Create `~/.config/brightspace-sync/config.json` or pass the equivalent CLI flags:

```json
{
  "baseUrl": "https://lms.example.edu",
  "sessionFile": "~/.config/brightspace-sync/session.json",
  "credentialsFile": "~/.config/brightspace-sync/credentials.json",
  "eventOutput": "data/events.json",
  "contentOutput": "data/content"
}
```

Supported environment variables:

```text
BRIGHTSPACE_CONFIG_FILE
BRIGHTSPACE_BASE_URL
BRIGHTSPACE_SESSION_FILE
BRIGHTSPACE_CREDENTIALS_FILE
BRIGHTSPACE_COOKIE
```

For multi-agent or multi-account use, add `--profile NAME`. Profiles derive separate session and
output paths so agents do not share writable state accidentally:

```bash
brightspace-sync session-status --profile research-agent
brightspace-sync download-content --profile research-agent --course-ids 123456
```

Do not run concurrent writers against the same profile.

The configuration file is intentionally non-secret. Unknown keys such as passwords or tokens are rejected.

Inspect the resolved file contents without displaying credentials or cookies:

```bash
brightspace-sync config-show
```

If a protected session already exists, the CLI can infer its Brightspace origin from the session metadata.

## Authentication

### Import a browser session

Export an authenticated Brightspace request as curl, save it outside the repository, and restrict it:

```bash
chmod 600 /private/path/brightspace-request.curl
brightspace-sync login \
  --base-url https://lms.example.edu \
  --curl-file /private/path/brightspace-request.curl
```

The parser discards unrelated SSO, analytics, and application cookies and retains only the minimum D2L session-cookie set. Delete the curl export after import.

### OAuth bearer token

```bash
export BRIGHTSPACE_ACCESS_TOKEN='...'
brightspace-sync session-status \
  --base-url https://lms.example.edu \
  --access-token-env BRIGHTSPACE_ACCESS_TOKEN
```

A future OAuth token manager only needs to implement token acquisition and renewal; the API client does not otherwise change.

### Stony Brook SSO + Duo adapter

This adapter is institution-specific and exported separately as `brightspace-sync/stonybrook`.

Store credentials outside the repository at the configured credentials path with mode `0600`, then run while the user is present for MFA:

```bash
brightspace-sync stonybrook-login --show-mfa-code
```

Verified Push matching codes are hidden unless `--show-mfa-code` is explicitly supplied. The code
is written to stderr for the attended login only and must not be copied into logs or persistent
files. Passcode-based MFA requires a caller-supplied non-echoing callback through the library API.

The adapter never persists passwords or MFA values. It stores only the resulting minimum D2L
session-cookie set in the protected session file.

Other institutions should use browser-session import, OAuth, or their own authentication adapter instead of relying on Stony Brook selectors.

## Session lifecycle

```bash
brightspace-sync session-status
brightspace-sync logout
```

The default session file is `~/.config/brightspace-sync/session.json`. Its directory is mode `0700` and the file is mode `0600` on POSIX systems. Session files must never be committed or pasted into chat.

Windows does not provide the same POSIX mode checks; protect local session and credential files
with appropriate Windows account and filesystem permissions.

## Synchronize calendar metadata

```bash
brightspace-sync sync \
  --from 2026-08-24 \
  --to 2027-01-01 \
  --output data/events.json
```

Useful options:

```text
--course-ids CSV
--from DATE_OR_ISO
--to DATE_OR_ISO
--output PATH
```

The event store is written atomically. Repeated runs classify records as added, updated, removed, or unchanged by stable source IDs and fingerprints.

## Download course files

A course selection is mandatory so that an agent cannot accidentally download every historical course:

```bash
brightspace-sync download-content \
  --course-ids 123456 \
  --output data/content
```

For a small trial:

```bash
brightspace-sync download-content \
  --course-ids 123456 \
  --max-files 2 \
  --output data/content
```

Content-download behavior:

- enumerates the learner-visible table of contents
- downloads file topics such as PDF, DOCX, PPTX, images, and HTML files
- skips hidden, locked, broken, external-link, and Brightspace ContentService/video topics
- streams to a temporary file and atomically renames after success
- enforces a 100 MiB per-file limit by default; change it with `--max-bytes`
- writes a `manifest.json` inside each course directory
- verifies local hashes and skips unchanged files on later runs

Removed Brightspace topics are omitted from future manifests, but existing local files are not
deleted automatically. This deliberately avoids destructive cleanup; review stale files manually.

Use `--all-courses` only after deliberately confirming that historical courses should also be downloaded.

## Library API

```js
import {
  BrightspaceClient,
  collectContentFileTopics,
  defaultSessionPath,
  readBrowserSession,
} from "brightspace-sync";

const baseUrl = process.env.BRIGHTSPACE_BASE_URL;
const { auth } = await readBrowserSession(defaultSessionPath(), baseUrl);
const client = new BrightspaceClient({ baseUrl, auth });
const versions = await client.discoverVersions();
const courses = await client.getMyCourseOfferings(versions.lp);

const toc = await client.getContentToc(versions.le, courses[0].OrgUnit.Id);
console.log(collectContentFileTopics(toc));
```

See `examples/library.mjs` and `docs/openclaw-agent-usage.md`.

## Repository safety

Generated output, sessions, credentials, curl exports, HAR files, and local environment files are ignored. Before a public push:

```bash
npm run check
npm pack --dry-run --json
```

Also inspect the complete Git diff for live course identifiers, personal paths, academic records, and authentication data. See `SECURITY.md` and `CONTRIBUTING.md`.

## Current limitations

- OAuth token acquisition/refresh is not included.
- Automatic expired-session renewal is not yet wired into ordinary sync/download commands.
- The included password/MFA browser adapter supports Stony Brook's current login flow, not arbitrary institutions.
- HTML pages represented as non-file topics and external services require separate adapters.
- No Brightspace write, submission, grading, or administrative APIs are implemented.

OAuth registrations should request only the scopes needed by the chosen operations, including
own-enrollment read, personal-calendar read, content table-of-contents read, and content-file read.
