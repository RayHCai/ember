# syntax=docker/dockerfile:1
# Any uv workspace service: --build-arg PACKAGE=ember-planner --build-arg SCRIPT=ember-planner, from the
# repo root. Arguments after the image name go to SCRIPT, e.g. `orchestrator` or `worker`.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /repo
# uv resolves the whole workspace, so every member's sources come in; only PACKAGE is installed.
COPY pyproject.toml uv.lock ./
COPY services/ services/
COPY tools/ tools/
ARG PACKAGE
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package "${PACKAGE}"

# Same base Python as the uv image, at the same path, so the venv's interpreter links stay valid.
FROM python:3.14-slim-bookworm
ARG SCRIPT
# rasterio's wheel links the system libexpat, which the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/* \n    && useradd --system --uid 10001 ember
COPY --from=build --chown=ember:ember /repo/.venv /repo/.venv
RUN ln -s "/repo/.venv/bin/${SCRIPT}" /usr/local/bin/service
ENV PATH=/repo/.venv/bin:$PATH PYTHONUNBUFFERED=1
USER ember
ENTRYPOINT ["service"]
