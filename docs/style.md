# Style

Formatters decide layout; this file covers what they cannot. Match the surrounding code first.

## All languages

- Names say what a thing is in domain terms: `watchZone`, `edgeServer`, `riskCell`, `civilian`.
  Use the readme's vocabulary; do not invent synonyms (no "site" for watch zone in one file and
  "area" in another).
- Small modules with one owner. A file over ~400 lines is a signal to split.
- Validate at the boundary (HTTP handler, queue consumer, WS message), trust inside.
- Errors carry context (`zone ${id}: no edge servers`), never swallowed.
- Comments: none by default; one line on why when the code cannot say it.
- Tests sit next to the code (`*.test.ts`, `*_test.go`, `tests/test_*.py`) and test behaviour
  through the public surface.

## TypeScript

- Formatter: prettier (4 spaces, single quotes, width 100). Linter: oxlint.
- ESM only, `import type` for types, no default exports except framework-required ones.
- No `any`; use `unknown` and narrow. Schemas at boundaries (zod or Fastify JSON schema).
- Fastify services: `src/app.ts` builds the app (testable via `inject`), `src/main.ts` only listens.
  Routes in `src/routes/<resource>.ts`, one plugin per resource.

## Go

- `gofmt`, `go vet`. Standard library first; add a dependency only with a reason.
- Services live in `services/<name>/cmd`; shared code in `internal/<pkg>`.
- `context.Context` is the first parameter of anything that does I/O. No goroutine without an owner
  that can stop it.

## Python

- `ruff format`, `ruff check`, `mypy --strict`. Python 3.12, `uv` only (no pip, no requirements files).
- `src/` layout, typed (`py.typed`). Dataclasses or pydantic at boundaries.
- Celery tasks are thin: parse, call a pure function, return. The pure function is what gets tested.

## Rust (dashboard shell)

- `cargo fmt`, `cargo clippy -D warnings`. Keep Rust to the Tauri shell; product logic lives in TS
  or behind the API.
