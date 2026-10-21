# syntax=docker/dockerfile:1

# Build stage: full workspace install, build the server, then extract a production-only copy.
FROM node:22.23.3-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
ENV HUSKY=0 CI=true
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter server build \
  && pnpm --filter server deploy --prod /out

# Runtime stage: only the built server and its production dependencies, run as non-root.
FROM node:22.23.3-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
