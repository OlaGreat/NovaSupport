# Database Setup

## Create A Supabase Project

1. Sign in to Supabase and create a new project.
2. Wait for the database to finish provisioning.
3. In project overview check the top of your screen click connect, select ORMs

## Copy Connection Strings

You will typically need two PostgreSQL connection strings:

- `DATABASE_URL`: used by the running backend application
- `DIRECT_URL`: used by Prisma migrations and direct database access

For NovaSupport, use the placeholders from `backend/.env.example` and replace the password portion with your actual database password.

Example direct connection:

```env
DIRECT_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-SUPABASE-PROJECT-REF].supabase.co:5432/postgres
```

`DATABASE_URL` can point to your pooled or normal connection string depending on your Supabase setup. Keep both values in `backend/.env`.

## Prisma Setup Commands

From the `backend/` directory:

```bash
npm install
npm run db:generate
npm run db:migrate
```

If you want an initial seed:

```bash
npm run db:seed
```

## Prisma Studio

To inspect records in a browser-like interface:

```bash
npm run db:studio
```

## Full Setup Shortcut

The backend includes a convenience command:

```bash
npm run db:setup
```

This runs Prisma generation, migration, and seed in sequence.

