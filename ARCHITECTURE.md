# NovaSupport Architecture

## Overview

NovaSupport uses a split-repository layout to keep the MVP understandable and contributor-friendly:

- `frontend/` serves the public product experience and wallet interaction layer
- `backend/` stores profile metadata and support records in PostgreSQL
- `contract/` contains the Soroban support contract used for onchain support intent

This split makes it easy for frontend, API, and smart contract contributors to move independently while still sharing a single product goal.

## Frontend Responsibilities

The frontend is a Next.js 14 App Router application responsible for:

- rendering the landing page and public creator profile pages
- connecting to Freighter
- showing network and wallet state for Stellar Testnet
- validating Stellar addresses before support actions are prepared
- eventually preparing support transactions for signing

Why this choice:

- Next.js App Router provides a familiar and hackathon-friendly React foundation
- TypeScript keeps interfaces easy to follow as the project grows
- Tailwind CSS keeps styling fast without adding heavy UI abstractions

## Backend Responsibilities

The backend is a lightweight Node.js + Express service responsible for:

- storing users and profile metadata
- storing accepted assets per profile
- storing support transaction records and offchain status tracking
- acting as a future bridge for indexing Horizon or contract events

Why this choice:

- Express keeps the service small and understandable
- Prisma gives contributors a clear schema-first workflow
- TypeScript improves readability for new contributors joining mid-build

## Contract Responsibilities

The Soroban contract manages support actions and real token transfers:

- accept a support action with recipient, asset info, amount, and optional message
- perform real token transfers from supporter to contract, with balance validation
- manage withdrawals where recipients can claim their accumulated support
- emit events that external services can index
- serve as a clean starting point for future escrow, milestones, or attestations

Why this choice:

- a small contract is easier to audit and extend during a submission sprint
- real token custody and transfers provide transparent onchain support flow

## Technical Decisions

### Split Repo Structure

The repo is split into `frontend/`, `backend/`, and `contract/` because the product has three clear domains with different tooling and contributor needs.

### Next.js 14

Chosen for a fast setup, App Router conventions, and a strong contributor experience for public pages and wallet UI.

### Prisma + PostgreSQL

Chosen for clear schema management, migrations, and easy onboarding. PostgreSQL on Supabase keeps hosted infrastructure simple for an MVP while remaining production-relevant.

### Freighter First

Freighter is the first wallet because it is one of the most recognizable Stellar wallets for web integrations and aligns with the requirement for obvious Stellar-specific intent.

### Stellar Testnet

The project targets Stellar Testnet first to make testing safe, cheap, and hackathon-friendly. Network values are exposed in environment files and referenced directly in code.

## Wallet Flow

The initial wallet flow is intentionally basic but real:

1. User opens the frontend and clicks connect.
2. The app checks whether Freighter is installed.
3. The app requests public key access through `@stellar/freighter-api`.
4. The connected address is displayed in the UI.
5. Frontend helpers validate addresses and prepare transaction intent details for future signing.

This is enough to prove wallet readiness while leaving room for a full support checkout flow later.

## Stellar Integration

NovaSupport signals Stellar-native intent in code and docs through:

- `@stellar/stellar-sdk` helpers for network access and address validation
- Horizon Testnet configuration in environment files
- Freighter wallet connection component
- Soroban contract scaffold under `contract/`
- backend schema fields that store Stellar network, assets, addresses, and transaction hashes

## Database Choice

Supabase-hosted PostgreSQL was selected because:

- setup is fast for hackathon contributors
- Prisma works cleanly with PostgreSQL
- it supports both pooled and direct connections for migrations
- contributors can inspect data visually with Prisma Studio

`DATABASE_URL` should point to the pooled or standard application connection, while `DIRECT_URL` should point to the direct database connection Prisma uses for migrations.

## Contract Scope

The contract manages real token transfers and custody while maintaining a clean, understandable interface. This keeps the MVP focused and gives the team clear extension points for:

- onchain profile ownership
- milestone-based releases
- tipping or recurring support logic

