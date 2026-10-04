from __future__ import annotations

import logging
from pathlib import Path

import httpx
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    chat_protocol_spec,
)

from .bridge import kv, make_handler
from .config import Settings
from .health import serve_health

README = Path(__file__).parent / "AGENT.md"
DESCRIPTION = (
    "Ember: wildfire risk analysis, autonomous drone surveillance, fire-spread forecasting, "
    "evacuation routing and emergency response coordination, "
    "with operator-approved civilian alerts."
)
KEYWORDS = [
    "wildfire",
    "fire risk",
    "drone surveillance",
    "evacuation",
    "emergency response",
    "fire spread forecast",
    "Lahaina",
]


def build_agent(settings: Settings, client: httpx.AsyncClient) -> Agent:
    agent = Agent(
        name="ember",
        seed=settings.seed,
        port=settings.port,
        mailbox=True,
        publish_agent_details=True,
        readme_path=str(README),
        description=DESCRIPTION,
        metadata={"keywords": KEYWORDS},
        # One ASI:One user's planner run must not hold up everyone else's questions.
        handle_messages_concurrently=True,
    )
    chat = Protocol(spec=chat_protocol_spec)
    handle = make_handler(client, settings.operator_agent_url, settings.agent_key)

    @chat.on_message(ChatMessage)  # type: ignore[untyped-decorator]
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
        await handle(ctx, sender, msg)

    @chat.on_message(ChatAcknowledgement)  # type: ignore[untyped-decorator]
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        ctx.logger.debug(kv("ack", sender=sender, msg_id=msg.acknowledged_msg_id))

    agent.include(chat, publish_manifest=True)
    return agent


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s level=%(levelname)s %(message)s")
    settings = Settings.from_env()
    client = httpx.AsyncClient(timeout=settings.timeout_s)
    agent = build_agent(settings, client)
    serve_health(agent.address, settings.health_port)
    agent.run()
