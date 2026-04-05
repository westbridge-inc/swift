# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email **security@westbridge.gy** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. You will receive a response within 48 hours
4. Once confirmed, we will work on a fix and coordinate disclosure

## Security Measures

- All dependencies are monitored via Dependabot
- Secret scanning and push protection are enabled
- CI pipeline includes security audits
- JWT tokens with short expiry and refresh rotation
- Rate limiting on all endpoints
- Input validation via Zod schemas
