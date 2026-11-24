# syntax=docker/dockerfile:1-labs@sha256:63e440b412b6acba117974e793b7e7f702e58ee65e044bdff1b8d388ee0d853b
# The Dockerfile syntax frontend is pinned by digest; update it deliberately.
# The Node base and Docker CLI COPY sources below use floating tags.
#
# The one image every local container runs. Compose Watch synchronizes source
# into it; dependencies, the Prisma client and the framework's generated
# contracts are owned by the image, so a host node_modules cannot shadow them.
# Normalize the install inputs for both the platform workspace and a vendored app.
# Only this stage sees the source bind. The install layer is keyed by its outputs.
FROM node:24-bookworm-slim AS release-inputs
WORKDIR /install
RUN --mount=type=bind,source=.,target=/app \
    if [ -f /app/packages/aws-studio/package.json ]; then \
      mkdir -p /install/packages/aws-studio && cd /app/packages/aws-studio \
      && cp -R package.json src scripts cli cdk database local dev /install/packages/aws-studio/; \
    else \
      mkdir -p vendor && node -e 'const fs = require("node:fs"); const pin = require("/app/package.json").dependencies?.["aws-studio"]; if (!/^file:vendor\/aws-studio-[A-Za-z0-9.-]+\.tgz$/.test(pin)) throw Error("Expected a vendored aws-studio archive."); const file = pin.slice(5); fs.copyFileSync("/app/" + file, file);'; \
    fi

FROM node:24-bookworm-slim
WORKDIR /workspace
ENV FRAMEWORK_REPOSITORY_ROOT=/workspace

# OpenSSL remains part of the image's existing system toolset; the application
# database runtime is Rust-free. docker and buildx: local-invocation-runner builds
# and runs task and container-Lambda images through the mounted socket, and a
# CLI this recent dispatches `docker build` to the buildx plugin.
# ca-certificates: the slim base ships none and Node brings its own, but buildx
# fetches registry tokens itself, so a base image the daemon has not cached
# fails with "x509: certificate signed by unknown authority" without them.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:28-cli /usr/local/libexec/docker/cli-plugins/docker-buildx \
     /usr/local/libexec/docker/cli-plugins/docker-buildx

# Manifests before sources: editing a handler must not reinstall the workspace.
# The glob reaches every depth, so adding a workspace needs no edit here.
COPY --from=release-inputs /install/ ./
COPY --parents .nvmrc package.json package-lock.json ./**/package.json ./
# Defer only the root's Prisma postinstall until its inputs are copied below.
# Dependency install scripts still run; restore the original manifest afterwards.
RUN --mount=type=cache,target=/root/.npm \
    cp package.json /tmp/workspace-package.json \
    && npm pkg delete scripts.postinstall \
    && npm ci --prefer-offline --no-audit --no-fund \
    && mv /tmp/workspace-package.json package.json

# The Prisma client is regenerated only when the contract changes.
COPY packages/database/prisma.config.ts ./packages/database/prisma.config.ts
COPY packages/database/prisma ./packages/database/prisma
RUN npm --workspace @repo/database run generate

COPY . .
RUN npm run framework:generate
