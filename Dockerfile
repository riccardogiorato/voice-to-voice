FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/realtime/package.json packages/realtime/package.json
COPY examples/demo/package.json examples/demo/package.json
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY examples examples
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "start"]
