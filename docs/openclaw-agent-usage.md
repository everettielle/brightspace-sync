# OpenClaw agent usage

Use the installed `brightspace-sync` binary when available. For a source checkout, set:

```bash
export BRIGHTSPACE_SYNC_DIR=/path/to/brightspace-sync
```

Then invoke `node "$BRIGHTSPACE_SYNC_DIR/dist/cli.js" ...` after `npm run build`.

## Safe workflow

1. Run `session-status` before a read operation. Use a distinct `--profile NAME` when multiple
   agents or accounts share the installation.
2. Use explicit course IDs for content downloads. Use `--all-courses` only when the user clearly requests it.
3. Keep credentials, cookies, curl exports, OAuth tokens, and session files outside repositories and chat.
4. If an interactive MFA flow is required, keep the user present and never persist the challenge or matching code.
5. Verify downloaded files through each course's `manifest.json`; re-running should classify unchanged files without downloading them again.
6. Do not upload, submit, post, or alter Brightspace content. This package is read-only.
7. Do not run concurrent writers against the same profile.

## Common commands

```bash
brightspace-sync session-status --profile agent-name
brightspace-sync sync --profile agent-name --from 2026-08-25 --to 2027-01-01
brightspace-sync download-content --profile agent-name --course-ids 123456 --output data/content
```

The optional `stonybrook-login --show-mfa-code` adapter uses Chromium for Stony Brook SSO and
Duo. The flag must be used only during an attended login in an authorized private context. Other
institutions should import a browser session, provide an OAuth bearer token, or implement their own
authentication adapter.
