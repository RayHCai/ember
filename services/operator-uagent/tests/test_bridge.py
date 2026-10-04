import json
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    MetadataContent,
    StartSessionContent,
    TextContent,
)

from ember_operator_uagent.bridge import (
    build_request,
    forward,
    make_handler,
    render_reply,
)
from ember_operator_uagent.config import Settings
from ember_operator_uagent.health import serve_health
from ember_operator_uagent.wire import AgentChatReply

NOW = datetime(2026, 1, 1, tzinfo=UTC)
REPLY: dict[str, Any] = {
    "text": "Fire detected in Lahaina.",
    "cards": [
        {
            "kind": "evacuation",
            "title": "Evacuation alerts",
            "markdown": "- ZIP 96761: waiting for operator approval",
            "data": [{"zipCode": "96761"}],
        }
    ],
}


def test_build_request_camel_case() -> None:
    req = build_request("agent1q", "sess", "hi", NOW)
    assert req.model_dump(mode="json", by_alias=True) == {
        "channel": "asi1",
        "sender": "agent1q",
        "sessionId": "sess",
        "text": "hi",
        "sentAt": NOW.isoformat(),
    }
    assert build_request("agent1q", None, "hi", NOW).session_id == "agent1q"


def test_render_reply_cards_and_metadata() -> None:
    text, meta = render_reply(AgentChatReply.model_validate(REPLY))
    assert text == (
        "Fire detected in Lahaina.\n\n### Evacuation alerts\n\n"
        "- ZIP 96761: waiting for operator approval"
    )
    assert json.loads(meta["ember.cards"])[0]["title"] == "Evacuation alerts"


def test_render_reply_without_cards() -> None:
    text, meta = render_reply(AgentChatReply(text="ok"))
    assert text == "ok"
    assert meta == {}


@pytest.mark.anyio
async def test_forward_posts_with_bearer() -> None:
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=REPLY)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        reply = await forward(client, "http://op:4006/", "k", build_request("a", "s", "hi", NOW))
    assert reply.cards[0].kind == "evacuation"
    assert str(seen[0].url) == "http://op:4006/v1/chat"
    assert seen[0].headers["authorization"] == "Bearer k"
    assert json.loads(seen[0].content)["sessionId"] == "s"


@pytest.mark.anyio
async def test_forward_no_key_no_header() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200, json=REPLY)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        await forward(client, "http://op", None, build_request("a", "s", "hi", NOW))


class FakeCtx:
    def __init__(self, events: list[str]) -> None:
        self.sent: list[Any] = []
        self.events = events
        self.session = uuid.uuid4()
        import logging

        self.logger = logging.getLogger("test")

    async def send(self, destination: str, message: Any) -> None:
        self.sent.append(message)
        self.events.append(type(message).__name__)


def chat(*content: Any) -> ChatMessage:
    return ChatMessage(content=list(content))


@pytest.mark.anyio
async def test_handler_acks_before_forwarding_then_replies() -> None:
    events: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        events.append("forward")
        return httpx.Response(200, json=REPLY)

    ctx = FakeCtx(events)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        handle = make_handler(client, "http://op", None, lambda: NOW)
        msg = chat(TextContent(text="status"))
        await handle(ctx, "agent1q", msg)
    assert events == ["ChatAcknowledgement", "forward", "ChatMessage"]
    ack, out = ctx.sent
    assert isinstance(ack, ChatAcknowledgement)
    assert ack.acknowledged_msg_id == msg.msg_id
    assert isinstance(out.content[0], TextContent)
    assert isinstance(out.content[1], MetadataContent)
    assert "ember.cards" in out.content[1].metadata


@pytest.mark.anyio
async def test_handler_replies_on_failure() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    ctx = FakeCtx([])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        await make_handler(client, "http://op", None)(ctx, "a", chat(TextContent(text="hi")))
    out = ctx.sent[1]
    assert "unreachable" in out.text()
    assert "ConnectError" in out.text()
    assert len(out.content) == 1


@pytest.mark.anyio
async def test_handler_http_error_status() -> None:
    ctx = FakeCtx([])
    transport = httpx.MockTransport(lambda r: httpx.Response(500))
    async with httpx.AsyncClient(transport=transport) as client:
        await make_handler(client, "http://op", None)(ctx, "a", chat(TextContent(text="hi")))
    assert "HTTPStatusError" in ctx.sent[1].text()


@pytest.mark.anyio
async def test_handler_session_start_only_acks() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not forward")

    ctx = FakeCtx([])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        await make_handler(client, "http://op", None)(ctx, "a", chat(StartSessionContent()))
    assert len(ctx.sent) == 1


def test_settings_requires_seed() -> None:
    with pytest.raises(SystemExit, match="EMBER_UAGENT_SEED"):
        Settings.from_env({})
    s = Settings.from_env({"EMBER_UAGENT_SEED": "x"})
    assert (s.port, s.health_port, s.timeout_s) == (8001, 4009, 90.0)
    assert s.operator_agent_url == "http://localhost:4006"


def test_health() -> None:
    server = serve_health("agent1q", 0, host="127.0.0.1")
    try:
        port = server.server_address[1]
        body = httpx.get(f"http://127.0.0.1:{port}/healthz").json()
        assert body == {"service": "operator-uagent", "ok": True, "address": "agent1q"}
    finally:
        server.shutdown()
        server.server_close()
