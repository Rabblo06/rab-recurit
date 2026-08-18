# rab

Workforce staffing platform — one backend, one database, three clients: web
console, venue portal, and a staff mobile app.

See [`rab-workforce-architecture.md`](./rab-workforce-architecture.md) for the
full system architecture, ERD, permission matrix, API structure, database
schema, design system and delivery plan. See [`CLAUDE.md`](./CLAUDE.md) for
working agreements when developing in this repo, [`THREAT-MODEL.md`](./THREAT-MODEL.md)
for the per-feature threat model, and [`SECURITY.md`](./SECURITY.md) for
secret rotation and vulnerability reporting.

## Getting started

```bash
corepack enable
yarn install
```

Then bring up Postgres + Redis, either way:

**Docker** (`packages/rab-docker/docker-compose.yml` also applies the
`postgres-init/01-roles.sql` role bootstrap automatically on first run):

```bash
docker compose -f packages/rab-docker/docker-compose.yml up -d
```

**Native Postgres + Redis** (if Docker isn't available — e.g. Docker Desktop
won't start): install Postgres 16+ and Redis, make sure both services are
running, create a `rab` database, then apply the same role bootstrap by hand:

```bash
psql -U postgres -c "CREATE DATABASE rab;"
psql -U postgres -d rab -f packages/rab-docker/postgres-init/01-roles.sql
```

Either way, then:

```bash
npx nx run rab-server:migration:run   # runs as rab_owner — set DATABASE_URL accordingly, see .env.example
yarn check-rls  # CI gate: every tenant table has RLS enabled + forced
yarn start      # server + front
yarn mobile     # Expo dev server
```

## Workspace layout

```
packages/
├── rab-server/          # NestJS API + BullMQ worker
├── rab-front/            # React console + venue portal
├── rab-mobile/           # Expo staff app
├── rab-shared/           # types, permission flags, money/duration/date utils
├── rab-ui/               # design tokens
├── rab-emails/           # react-email templates
├── rab-docker/           # Dockerfiles + compose
├── rab-e2e-testing/      # Playwright + Maestro
└── rab-utils/            # scripts, codegen, seeders
```
