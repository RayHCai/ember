@AGENTS.md

## Claude Code specifics

- Project subagents live in `.claude/agents/`; use them over the generic types for scoped work.
- Use the `Explore` agent for broad searches; read files directly when you know the path.
- Do not run `pnpm dev` or `docker compose up` in the foreground; use background execution.
