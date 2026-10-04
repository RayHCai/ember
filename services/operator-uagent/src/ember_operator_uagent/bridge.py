"""Forwarding and rendering as pure functions, plus the ChatMessage handler factory."""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Protocol

import httpx
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
)

from .wire import AGENT_CHAT_PATH, AgentCard, AgentChatReply, AgentChatRequest

CARDS_METADATA_KEY = "ember.cards"

log = logging.getLogger("ember.operator_uagent")


def kv(event: str, **fields: object) -> str:
    return " ".join([f"event={event}", *(f"{k}={v!r}" for k, v in fields.items())])


def build_request(sender: str, session: str | None, text: str, now: datetime) -> AgentChatRequest:
    return AgentChatRequest(
        channel="asi1",
        sender=sender,
        session_id=session or sender,
        text=text,
        sent_at=now.isoformat(),
    )


async def forward(
    client: httpx.AsyncClient, url: str, key: str | None, req: AgentChatRequest
) -> AgentChatReply:
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    res = await client.post(
        f"{url.rstrip('/')}{AGENT_CHAT_PATH}",
        json=req.model_dump(mode="json", by_alias=True),
        headers=headers,
    )
    res.raise_for_status()
    return AgentChatReply.model_validate(res.json())


def render_card(card: AgentCard) -> str:
    return f"### {card.title}\n\n{card.markdown}"


def render_reply(reply: AgentChatReply) -> tuple[str, dict[str, str]]:
    text = "\n\n".join([reply.text, *(render_card(c) for c in reply.cards)])
    metadata: dict[str, str] = {}
    if reply.cards:
        cards = [c.model_dump(mode="json", by_alias=True) for c in reply.cards]
        metadata[CARDS_METADATA_KEY] = json.dumps(cards)
    return text, metadata


def to_chat_message(text: str, metadata: dict[str, str]) -> ChatMessage:
    content: list[TextContent | MetadataContent] = [TextContent(text=text)]
    if metadata:
        content.append(MetadataContent(metadata=metadata))
    return ChatMessage(content=list(content))


def unreachable_text(error: BaseException) -> str:
    return f"Ember's operator service is unreachable right now ({type(error).__name__})."


class ChatContext(Protocol):
    logger: logging.Logger
    session: object

    async def send(
        self, destination: str, message: ChatMessage | ChatAcknowledgement
    ) -> object: ...


Handler = Callable[[ChatContext, str, ChatMessage], Awaitable[None]]


def make_handler(
    client: httpx.AsyncClient,
    url: str,
    key: str | None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> Handler:
    async def handle(ctx: ChatContext, sender: str, msg: ChatMessage) -> None:
        await ctx.send(sender, ChatAcknowledgement(timestamp=now(), acknowledged_msg_id=msg.msg_id))
        if any(isinstance(c, StartSessionContent | EndSessionContent) for c in msg.content):
            ctx.logger.info(kv("session_marker", sender=sender))
        text = msg.text().strip()
        if not text:
            return
        session = str(getattr(ctx, "session", None) or sender)
        req = build_request(sender, session, text, now())
        try:
            reply = await forward(client, url, key, req)
        except Exception as err:
            ctx.logger.error(kv("forward_failed", sender=sender, error=type(err).__name__))
            await ctx.send(sender, to_chat_message(unreachable_text(err), {}))
            return
        body, metadata = render_reply(reply)
        ctx.logger.info(kv("replied", sender=sender, cards=len(reply.cards)))
        await ctx.send(sender, to_chat_message(body, metadata))

    return handle
