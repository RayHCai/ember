# operator-uagent

A thin Fetch.ai uAgent bridge. It speaks the Agent Chat Protocol on Agentverse and ASI:One and
forwards every chat message to operator-agent over HTTP. The reasoning, intent handling and state
live in operator-agent; this service holds none of it.

```
ASI:One -> Agentverse mailbox -> operator-uagent -> POST /v1/chat operator-agent
```

Each `ChatMessage` is acknowledged at once, then its text is posted as an `AgentChatRequest`
(`channel: "asi1"`, `sessionId` from the uAgents session). The `AgentChatReply` goes back as one
`ChatMessage`: the reply text, each card rendered as markdown with its "Reply with:" actions, and
a `MetadataContent` carrying the cards as JSON under `ember.cards`. If operator-agent fails or
times out, the user gets a short "unreachable" message naming the error class. Wire shapes mirror
`packages/contracts/src/agent.ts`.

## Environment

| Variable                    | Default                 | Purpose                                       |
| --------------------------- | ----------------------- | --------------------------------------------- |
| `EMBER_UAGENT_SEED`         | required                | Seed phrase that fixes the agent's address    |
| `EMBER_UAGENT_PORT`         | `8001`                  | uAgent HTTP port                              |
| `EMBER_UAGENT_HEALTH_PORT`  | `4009`                  | `GET /healthz` port                           |
| `EMBER_OPERATOR_AGENT_URL`  | `http://localhost:4006` | operator-agent base URL                       |
| `EMBER_AGENT_KEY`           | unset                   | Sent as `Authorization: Bearer` when set      |
| `EMBER_UAGENT_TIMEOUT_S`    | `90`                    | Timeout for the operator-agent call, seconds  |

## Run

With the rest of Ember, supervised: `node scripts/asi1/ember.mjs start` (see
[docs/asi1-agent.md](../../docs/asi1-agent.md)). On its own:

```
uv run --package ember-operator-uagent ember-operator-uagent
```

## Register on Agentverse

The agent uses a mailbox, created once per agent address:

- `node scripts/asi1/ember.mjs connect-mailbox` with `AGENTVERSE_API_KEY` set calls the agent's
  local `/connect` with the key, as the Agent Inspector does; or
- open the Agent Inspector link the agent prints and click Connect → Mailbox (Chrome, with local
  network access allowed for agentverse.ai).

On connect it publishes its name, description, keywords and readme
(`src/ember_operator_uagent/AGENT.md`) to Agentverse, where ASI:One finds it, along with the Agent
Chat Protocol manifest. The address follows from `EMBER_UAGENT_SEED`, so keeping the seed keeps the
address and the mailbox. Messages are handled concurrently: one user's planner run does not delay
another's question.

## Checks

```
pnpm run lint --filter @ember/operator-uagent
pnpm run typecheck --filter @ember/operator-uagent
pnpm run test --filter @ember/operator-uagent
```
