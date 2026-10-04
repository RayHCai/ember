# syntax=docker/dockerfile:1
# Any Go service: --build-arg SERVICE=edge-manager, from the repo root.
ARG GO_VERSION=1.24

FROM golang:${GO_VERSION} AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY internal/ internal/
ARG SERVICE
COPY services/${SERVICE}/ services/${SERVICE}/
# modernc.org/sqlite is pure Go, so a static binary needs no libc in the image.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service ./services/${SERVICE}/cmd \
    && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build --chown=nonroot:nonroot /out/data /data
COPY --from=build /out/service /service
WORKDIR /data
ENTRYPOINT ["/service"]
