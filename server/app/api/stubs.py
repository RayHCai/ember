"""Routes later phases fill in. Each answers 501 until it is built."""

from fastapi import APIRouter, HTTPException

router = APIRouter()


def not_built(what: str) -> HTTPException:
    return HTTPException(501, f"Not built yet: {what}.")


@router.post("/zones/{zone_id}/surveys")
def run_survey(zone_id: str) -> None:
    raise not_built("surveys")


@router.post("/zones/{zone_id}/incidents")
def start_incident(zone_id: str) -> None:
    raise not_built("incidents")


@router.post("/approvals/{approval_id}/approve")
def approve(approval_id: str) -> None:
    raise not_built("approvals")


@router.post("/incidents/{incident_id}/suppression")
def suppression(incident_id: str) -> None:
    raise not_built("suppression")


@router.post("/agent/chat")
def agent_chat() -> None:
    raise not_built("agent chat")
