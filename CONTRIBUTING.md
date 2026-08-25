# Contributing

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

Node.js 22 or newer is required.

## Project rules

- Keep the core client institution-agnostic.
- Put institution-specific browser authentication behind an explicitly named adapter.
- Use official Brightspace APIs for course data and browser automation only for authentication.
- Preserve HTTPS and same-origin checks for authenticated requests.
- Never add live course identifiers, credentials, session exports, or personal academic data to fixtures.
- Add tests for API routes, binary integrity, path safety, permissions, and reconciliation behavior.
- Keep all operations read-only.
- Keep generated course files and manifests out of Git; they can contain copyrighted or private course material.
- Treat MFA display as an explicit, attended action and never include matching codes in ordinary event logs.

## Before opening a pull request

- Run the full test suite.
- Inspect `npm pack --dry-run --json` and confirm only intended files are included.
- Search the diff for institutional secrets, personal paths, and live identifiers.
- Document new CLI flags and exported APIs.
