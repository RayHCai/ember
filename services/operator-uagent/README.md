# operator-uagent

A thin Fetch.ai uAgent bridge. It speaks the Agent Chat Protocol on Agentverse and ASI:One and
forwards every chat message to operator-agent over HTTP. What Ember knows and does lives in
operator-agent; this service holds none of it.

```
ASI:One -> Agentverse mailbox -> operator-uagent -> POST /v1/chat operator-agent
```

Each `ChatMessage` is acknowledged at once, then its text is posted as an `AgentChatRequest`
(`channel: "asi1"`, `sessionId` from the uAgents session). The `AgentChatReply` goes back as one
`ChatMessage`: the reply text, each card rendered as markdown, and a `MetadataContent` carrying the
cards as JSON under `ember.cards`. If operator-agent fails or times out, the user gets a short
"unreachable" message naming the error class. Wire shapes mirror `packages/contracts/src/agent.ts`.

This is a uv project of its own, not a member of the root workspace: `uagents` pins protobuf below
6 through cosmpy, which would hold drone-runtime and fire-seg back. It has its own `uv.lock` and
`.venv`; `uv sync` here installs it.

## Environment

| Variable                   | Default                 | Purpose                                      |
| -------------------------- | ----------------------- | -------------------------------------------- |
| `EMBER_UAGENT_SEED`        | required                | Seed phrase that fixes the agent's address   |
| `EMBER_UAGENT_PORT`        | `8001`                  | uAgent HTTP port                             |
| `EMBER_UAGENT_HEALTH_PORT` | `4009`                  | `GET /healthz` port                          |
| `EMBER_OPERATOR_AGENT_URL` | `http://localhost:4006` | operator-agent base URL                      |
| `EMBER_AGENT_CHAT_KEY`     | unset                   | Sent as `Authorization: Bearer` when set     |
| `EMBER_UAGENT_TIMEOUT_S`   | `90`                    | Timeout for the operator-agent call, seconds |

## Run

```
cd services/operator-uagent
uv run ember-operator-uagent
```

## Register on Agentverse

The agent uses a mailbox, created once per agent address: open the Agent Inspector link the agent
prints and click Connect → Mailbox (Chrome, with local network access allowed for agentverse.ai).

On connect it publishes its name, description, keywords and readme
(`src/ember_operator_uagent/AGENT.md`) to Agentverse, where ASI:One finds it, along with the Agent
Chat Protocol manifest. The address follows from `EMBER_UAGENT_SEED`, so keeping the seed keeps the
address and the mailbox. Messages are handled concurrently.

## Checks

```
pnpm run lint --filter @ember/operator-uagent
pnpm run typecheck --filter @ember/operator-uagent
pnpm run test --filter @ember/operator-uagent
```
