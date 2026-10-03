# 0001: Repository foundation

**Status:** done
**Touches:** repo root, all packages

## Goal

A polyglot monorepo where every service in the readme exists as a package behind one gate, with
agent docs, hooks and CI in place before feature work starts.

## Plan

- [x] pnpm + turbo workspace; Go single module; uv workspace for Python
- [x] Stub package per service with a health check and one test
- [x] lefthook pre-commit, commit-msg, pre-push, post-commit
- [x] CI, security and release workflows; dependabot
- [x] AGENTS.md, CLAUDE.md, architecture, style, work tracking, project subagents

## Decisions

- Monorepo with independently deployable services, not a single process: the readme already splits
  by runtime (Go on edge hardware, Python on drones and planners), so one binary is not possible.
- Every language runs through turbo via `package.json` scripts, so there is one gate to learn.
- Tauri and Expo scaffolds are deferred to the first feature in each app, so their generators run
  against current versions.

## Log

- 2026-10-02: foundation landed. Next: scaffold Tauri dashboard, API watch-zone routes + schema.
