# syntax=docker/dockerfile:1.7
# basics-worker container — CLOUD-AGENT-PLAN.md §16.1 / §16.3.
# Build context: repo root. Invoke as: `docker build -f worker/Dockerfile .`

FROM oven/bun:1.1.38-alpine AS build
RUN apk add --no-cache nodejs npm git
RUN npm install -g pnpm@10.33.0
WORKDIR /repo

# Copy workspace metadata first for max layer cache.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY shared/package.json   ./shared/
COPY harness/package.json  ./harness/
COPY worker/package.json   ./worker/

# Install only what worker transitively needs.
RUN pnpm install --frozen-lockfile --filter @basics/worker...

# Source + tsconfigs.
COPY shared/tsconfig.json shared/tsconfig.build.json ./shared/
COPY shared/src ./shared/src
COPY harness/tsconfig.json harness/tsconfig.build.json ./harness/
COPY harness/src ./harness/src
COPY worker/tsconfig.json worker/tsconfig.build.json ./worker/
COPY worker/pricing.json ./worker/
COPY worker/src ./worker/src

# Build deps in dep-order, then bundle worker into a single ESM file.
# G.1b — also bundle the opencode plugin into a standalone file that
# opencode loads at session boot via OPENCODE_CONFIG_CONTENT.
RUN pnpm --filter @basics/shared  build \
 && pnpm --filter @basics/harness build \
 && pnpm --filter @basics/worker  build \
 && cd worker \
 && bun build src/main.ts \
      --target=bun \
      --outdir=dist-bundle \
      --minify \
 && bun build src/opencode-plugin/index.ts \
      --target=bun \
      --outfile=dist-bundle/opencode-plugin.js \
      --minify

FROM oven/bun:1.1.38-alpine AS runtime
WORKDIR /app
# G.1a — opencode CLI runs as a subprocess driving the LLM loop.
# bubblewrap powers the bash tool sandbox (B.3); curl for healthcheck CLI;
# bash + tar required by the opencode install script (it auto-detects musl
# via /etc/alpine-release and downloads the correct binary). The npm
# `opencode-ai` postinstall picks the glibc x64 build by default which
# fails on alpine — hence the curl installer instead.
RUN apk add --no-cache bash curl tar bubblewrap libstdc++ \
 && curl -fsSL https://opencode.ai/install | VERSION=1.14.41 bash -s -- --no-modify-path \
 && cp -v /root/.opencode/bin/opencode /usr/local/bin/opencode \
 && /usr/local/bin/opencode --version
COPY --from=build /repo/worker/dist-bundle/main.js ./main.js
COPY --from=build /repo/worker/dist-bundle/opencode-plugin.js ./opencode-plugin.js
ENV NODE_ENV=production
ENV BWRAP_AVAILABLE=1
EXPOSE 8080
USER bun
ENTRYPOINT ["bun", "run", "main.js"]
