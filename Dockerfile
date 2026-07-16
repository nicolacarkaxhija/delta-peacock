# build stage: compile the CLI bundle
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

# runtime stage: production dependencies plus git for local diffing
FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY schema ./schema
RUN useradd --create-home reviewer
USER reviewer
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
