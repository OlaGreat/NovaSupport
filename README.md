# NovaSupport

NovaSupport is a Stellar-native support platform for open-source maintainers, creators, and developers who want to receive community funding directly on Stellar. The MVP centers on public creator profiles, wallet-ready support flows, and clear onchain intent using Stellar Testnet, Freighter, Horizon, and Soroban.

## One-Line Pitch

NovaSupport makes it effortless for Stellar ecosystem contributors to receive community support in USDC, XLM, and other Stellar assets through shareable profile pages with full onchain transparency.

## Problem

Many open-source contributors and ecosystem builders struggle to receive support in ways that are fast, transparent, and globally accessible. Traditional donation tools are often expensive, opaque, or disconnected from onchain identity and activity.

## Why It Matters For Stellar

NovaSupport is designed to feel native to the Stellar ecosystem:

- support flows are built around Stellar addresses and Testnet tooling
- contributors can signal accepted Stellar assets like XLM and USDC
- Freighter is the first wallet connection target for easy ecosystem onboarding
- Horizon and Soroban are part of the foundation from day one
- low fees and fast settlement make small recurring support practical

## Tech Stack

- Frontend: Next.js 14 App Router, React, TypeScript, Tailwind CSS
- Backend: Node.js, Express, TypeScript, Prisma
- Database: PostgreSQL on Supabase
- Blockchain: Stellar Testnet, Horizon, Soroban, Freighter
- SDKs: `@stellar/stellar-sdk`, `@stellar/freighter-api`
- Contract: Rust + Soroban SDK

## Repository Structure

```text
NovaSupport/
├── frontend/              # Next.js app for landing pages, profile pages, wallet UX
├── backend/               # Express + Prisma service for profile and support metadata
├── contract/              # Soroban workspace and minimal support contract
├── docs/                  # Project setup and operational docs
├── ARCHITECTURE.md        # Technical overview and decision record
├── CONTRIBUTING.md        # Contributor guide and boundaries
└── README.md
```


## Prerequisites

Before you begin, ensure you have:

- **Node.js 18+** and npm
- **Rust** and Cargo (for Soroban contract)
- **Soroban CLI** - Install: `cargo install --locked soroban-cli`
- **PostgreSQL** database (or Supabase account)
- **Freighter wallet** browser extension - [Install here](https://freighter.app)
- **Git** for cloning the repository


## Local Development

### 1. Frontend

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Runs on `http://localhost:3000`.

### 2. Backend

```bash
cd backend
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Runs on `http://localhost:4001`.

### 3. Contract

```bash
cd contract
cargo test
```

You will need Rust, the Soroban toolchain, Node.js, and a reachable PostgreSQL database.

## Contributor-Friendly Repo Guide

This repo is split so contributors can work in parallel without untangling a monolith:

- `frontend/` is where public product experience and wallet interactions live
- `backend/` holds data models and API entrypoints for profiles and support records
- `contract/` is intentionally small so Soroban contributors can extend it safely
- `docs/` explains setup choices that are easy to miss


## Contributing

We welcome contributions! NovaSupport is designed to be contributor-friendly.

### Quick Start for Contributors

1. **Fork the repository**
2. **Clone your fork**
3. **Create a branch:** `git checkout -b feat/your-feature`
4. **Make changes**
5. **Test locally**
6. **Commit:** `git commit -m "feat: add your feature"`
7. **Push:** `git push origin feat/your-feature`
8. **Open Pull Request**

### Good First Issues

Looking to contribute? Check out issues labeled:
- `good first issue` - Easy tasks for newcomers
- `help wanted` - We need your expertise!
- `documentation` - Help improve our docs

### Contribution Areas

- 🎨 **Frontend** - React/Next.js components, UI/UX
- ⚙️ **Backend** - API endpoints, database models
- 🔗 **Blockchain** - Stellar/Soroban integration
- 📝 **Documentation** - Guides, tutorials, examples
- 🧪 **Testing** - Unit tests, integration tests

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.


## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

Built for [Stellar Wave](https://drips.network) with ❤️

Special thanks to:
- Stellar Development Foundation
- Drips Network
- Soroban community
- All contributors