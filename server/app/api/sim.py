from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..runtime import Runtime
from ..sim.clock import MAX_SPEED
from .deps import get_runtime

router = APIRouter(prefix="/sim", tags=["sim"])


class SpeedBody(BaseModel):
    speed: float


@router.get("")
def get_sim(runtime: Runtime = Depends(get_runtime)) -> dict:
    return runtime.clock.state()


@router.post("/speed")
def set_speed(body: SpeedBody, runtime: Runtime = Depends(get_runtime)) -> dict:
    try:
        runtime.clock.set_speed(body.speed)
    except ValueError:
        raise HTTPException(400, f"Speed must be more than 0 and at most {MAX_SPEED:g}.")
    return runtime.clock.state()


@router.post("/pause")
def pause(runtime: Runtime = Depends(get_runtime)) -> dict:
    runtime.clock.pause()
    return runtime.clock.state()


@router.post("/resume")
def resume(runtime: Runtime = Depends(get_runtime)) -> dict:
    runtime.clock.resume()
    return runtime.clock.state()
