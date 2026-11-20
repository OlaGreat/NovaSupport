# Contributing To NovaSupport

## Project Goal

NovaSupport is a Stellar-native support platform focused on helping maintainers, creators, and developers receive transparent community funding through Stellar. The near-term goal is a submission-ready MVP with public profiles, wallet connection, and obvious Stellar Testnet integration.

## Contribution Rules

- keep changes small and focused
- preserve the split between `frontend/`, `backend/`, and `contract/`
- prefer readable code over abstraction-heavy patterns
- document intent clearly when a feature is scaffolded but not complete
- do not switch the target network away from Stellar Testnet in MVP work
- keep Freighter as the first wallet unless the team explicitly expands wallet support
- write working test
- build project before contribution and before commiting.


## Environment Setup

### Frontend

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

### Contract

```bash
cd contract
rustup target add wasm32-unknown-unknown
cargo test
```

Install Soroban CLI separately if you want to build, deploy, or inspect the contract on Stellar Testnet.

---

## Working on the Contract

The on-chain logic lives in `contract/contracts/support_page/src/lib.rs` and is compiled to WASM for deployment on Stellar.

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add the WASM compilation target
rustup target add wasm32-unknown-unknown

# Install Stellar CLI (includes Soroban support)
cargo install --locked stellar-cli --features opt
```

### Run contract tests

```bash
cd contract
cargo test
```

All tests must pass before opening a PR.

### Build the WASM

```bash
stellar contract build
```

Output: `target/wasm32-unknown-unknown/release/support_page.wasm`

### Deploy to Testnet (maintainers only)

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/support_page.wasm \
  --network testnet \
  --source <your-alias>
```

`<your-alias>` refers to a Stellar CLI identity configured locally via `stellar keys generate` or `stellar keys add`.

### Adding a new function

1. Add the function to `src/lib.rs`
2. Add a unit test inside the `#[cfg(test)]` block at the bottom of the file
3. Run `cargo test` — all tests must pass before opening a PR

<!-- Closes #563 -->


### Local Database Setup (Docker)

For local development, you can use Docker Compose to run PostgreSQL instead of setting up Supabase:

```sh
# Start the database
docker compose up -d

# Run migrations and seed data
cd backend
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
```

To stop the container:
```sh
docker compose down
```

To wipe all data and start fresh:
```sh
docker compose down -v
```

The Docker container uses these default credentials (matching `backend/.env.example`):
- User: `novasupport`
- Password: `novasupport`
- Database: `novasupport`
- Port: `5432`


## Guidance For Small PRs

- one concern per PR is ideal
- include screenshots for frontend UI changes
- include schema notes for Prisma changes
- mention any new environment variables explicitly
- keep naming consistent with `NovaSupport`


## Branch Protection & CI

All pull requests must pass the following CI status checks before merging to `main`:

- **Frontend CI** — installs dependencies, runs tests (`npm test`), runs lint, and builds the Next.js app (`npm run build`)
- **Backend CI** — generates the Prisma client, applies migrations, runs lint (`npm run lint`), runs backend tests (`npm run test`), and compiles TypeScript (`npm run build`)
- **Contract CI** — runs contract tests (`cargo test`) and builds the contract for the WASM target (`cargo build --target wasm32-unknown-unknown --release`)

Each workflow runs on `pull_request` events for its respective directory and on `push` to `main`. The contract deploy workflow is triggered manually via `workflow_dispatch`.

### Setting Up Branch Protection (Maintainers)

1. Go to **Settings → Branches** on the GitHub repo
2. Click **Add branch ruleset** (or edit the existing `main` rule)
3. Set the target branch to `main`
4. Enable **Require status checks to pass before merging**
5. Add the following required status checks:
   - `Frontend checks` (Frontend CI)
   - `Backend checks` (Backend CI)
   - `Contract checks` (Contract CI)
6. Enable **Require a pull request before merging**
7. Optionally enable **Require conversation resolution before merging**
8. Save the ruleset


