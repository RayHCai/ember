# @ember/api

See [docs/architecture.md](../../docs/architecture.md) for what this service owns.

## Database

Prisma 7 against the shared Postgres in `compose.yaml`; `DATABASE_URL` comes from the root `.env`
(copy it next to this package or export it). The generated client in `src/generated/` is gitignored
and rebuilt by `build`, `typecheck` and `test`.

```
pnpm --filter @ember/api db:deploy    # apply migrations
pnpm --filter @ember/api db:migrate   # create a migration after editing prisma/schema.prisma
```

## Routes

| Method | Path         | Body                    | Result                                     |
| ------ | ------------ | ----------------------- | ------------------------------------------ |
| GET    | `/healthz`   |                         | `{ service, ok }`                          |
| POST   | `/civilians` | `CreateCivilianRequest` | 201 `Civilian`; 400 invalid; 409 dup phone |

`phone` is E.164 (`+15551234567`), `zipCode` is a 5-digit US ZIP.
