# Stage 1: prune workspace to just the CLI + shared + their transitive deps
FROM node:20-alpine AS pruner
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY . .
RUN npx turbo prune sygil --docker

# Stage 2: install + build
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=pruner /app/out/json/ .
RUN npm install
COPY --from=pruner /app/out/full/ .
# turbo prune omits root config files — copy the shared tsconfig manually
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
RUN npx turbo build --filter=sygil

# Stage 3: slim runtime — only ship CLI + shared dist + templates
FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup --system --gid 1001 sygil && adduser --system --uid 1001 sygil
COPY --from=builder --chown=sygil:sygil /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=sygil:sygil /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=builder --chown=sygil:sygil /app/packages/shared/package.json ./packages/shared/package.json
RUN npm install --omit=dev --omit=optional --workspace=sygil --ignore-scripts
COPY --from=builder --chown=sygil:sygil /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder --chown=sygil:sygil /app/packages/cli/dist-ui ./packages/cli/dist-ui
COPY --from=builder --chown=sygil:sygil /app/packages/cli/templates ./packages/cli/templates
COPY --from=builder --chown=sygil:sygil /app/packages/shared/dist ./packages/shared/dist
WORKDIR /workspace
USER sygil
ENTRYPOINT ["node", "/app/packages/cli/dist/index.js"]
