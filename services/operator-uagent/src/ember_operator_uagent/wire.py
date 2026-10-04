"""operator-agent chat shapes; mirror of packages/contracts/src/agent.ts."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

AGENT_CHAT_PATH = "/v1/chat"

AgentChannel = Literal["asi1", "dashboard"]


class Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, frozen=True, extra="ignore"
    )


class AgentChatRequest(Wire):
    channel: AgentChannel
    sender: str
    session_id: str
    text: str
    sent_at: str


class CardAction(Wire):
    label: str
    reply: str


class AgentCard(Wire):
    kind: str
    title: str
    markdown: str
    actions: list[CardAction] = Field(default_factory=list)
    data: object = None


class ToolCall(Wire):
    name: str
    ok: bool


class AgentChatReply(Wire):
    text: str
    cards: list[AgentCard] = Field(default_factory=list)
    decision_ids: list[str] = Field(default_factory=list)
    tool_calls: list[ToolCall] = Field(default_factory=list)
