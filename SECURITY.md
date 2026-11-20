# Security Policy

This document describes the vulnerability disclosure policy for the NovaSupport platform as a whole — the Next.js frontend, the Express backend API, and the Soroban smart contract.

For the contract-specific trust model and security considerations, see [contract/SECURITY.md](contract/SECURITY.md).

---

## Supported Components

| Component | Path | Description |
|-----------|------|-------------|
| Frontend | `frontend/` | Next.js 14 App Router, Freighter wallet integration |
| Backend API | `backend/` | Express + Prisma, JWT auth, Stellar transaction verification |
| Smart Contract | `contract/` | Soroban support contract on Stellar Testnet |

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a security issue in any part of NovaSupport, report it privately so it can be assessed and patched before public disclosure.

### How to report

Open a [GitHub Security Advisory](https://github.com/OlaGreat/NovaSupport/security/advisories/new) via the **Security** tab of this repository. This keeps the report private and notifies the maintainers directly.

If you are unable to use GitHub's private reporting flow, email the maintainers directly. Check the repository's GitHub profile for contact details.

### What to include

A useful report includes:
- A description of the vulnerability and affected component
- Steps to reproduce or a proof-of-concept
- The potential impact (e.g. auth bypass, data exposure, funds at risk)
- Any suggested fix or mitigation, if you have one

---

## Disclosure Policy

- Maintainers will acknowledge receipt within **72 hours**.
- We aim to assess severity and provide an initial response within **7 days**.
- We will coordinate a fix and agree on a disclosure timeline with the reporter.
- We follow **responsible disclosure** — vulnerabilities are not made public until a fix is available, or 90 days have elapsed, whichever comes first.

---

## Scope

### In scope

- Authentication and authorisation bypasses in the backend API
- JWT handling weaknesses (`backend/src/auth.ts`)
- Stellar transaction verification bypasses (`backend/src/services/verify-transaction.ts`)
- Input validation issues that could lead to SQL injection, XSS, or data corruption
- Exposed secrets or credentials in source code or CI configuration
- CORS misconfiguration that allows unintended cross-origin access
- Smart contract vulnerabilities (see also [contract/SECURITY.md](contract/SECURITY.md))

### Out of scope

- Bugs in third-party dependencies (report those upstream)
- Rate limiting bypass via distributed IPs (known limitation of IP-based limiting)
- Issues that require physical access to a maintainer's machine
- Theoretical vulnerabilities with no practical exploit path

---

## Smart Contract Security

The Soroban contract has its own trust model document at [contract/SECURITY.md](contract/SECURITY.md), which covers:
- What the contract guarantees (auth, amount validation, event emission)
- What it does NOT guarantee (fund custody, recipient validation, duplicate prevention)
- Deployment and upgrade security
- Things to watch for when extending the contract

---

## Hall of Fame

Security researchers who responsibly disclose valid vulnerabilities will be acknowledged here (with permission).
