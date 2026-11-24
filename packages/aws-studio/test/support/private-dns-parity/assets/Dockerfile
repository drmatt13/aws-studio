# Phase-zero fixture only. This image is not an application runtime projection.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
FROM ${NODE_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends nftables iproute2 curl dnsutils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /fixture
COPY assets/ ./assets/
COPY probe.mjs ./probe.mjs
USER 1000:1000
ENTRYPOINT ["node", "assets/fixture.mjs"]
