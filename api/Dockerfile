FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json ./api/
COPY harness/package.json ./harness/
COPY shared/package.json ./shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY --from=deps /app/harness/node_modules ./harness/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY . .
RUN pnpm --filter @basics/shared build && pnpm --filter @basics/harness build && pnpm --filter @basics/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/node_modules ./api/node_modules
COPY --from=build /app/harness/node_modules ./harness/node_modules
COPY --from=build /app/shared/node_modules ./shared/node_modules
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/harness/dist ./harness/dist
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/api/package.json ./api/
COPY --from=build /app/harness/package.json ./harness/
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/package.json ./

EXPOSE 3001
CMD ["node", "api/dist/index.js"]
