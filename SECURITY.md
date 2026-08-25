# Security policy

## Sensitive data

Never commit or publish:

- Brightspace cookies or stored session files
- OAuth access or refresh tokens
- institutional usernames or passwords
- browser curl exports, HAR files, or authenticated screenshots
- MFA passcodes or Verified Push matching codes

The repository ignores generated data and common session-export formats. The CLI also restricts stored credentials and sessions to owner-only permissions on POSIX systems.

Configuration files must contain only non-secret paths and the Brightspace HTTPS origin. Secret-like keys are rejected by the configuration parser.

## Reporting a vulnerability

Until a public repository and security contact are selected, report vulnerabilities privately to the repository owner. Do not open a public issue containing credentials, cookies, tokens, or reproduction data from a live course.
