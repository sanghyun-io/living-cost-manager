FROM node:24-alpine AS build

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/shared/src ./packages/shared/src
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/src ./apps/api/src

RUN pnpm db:generate
RUN pnpm --filter @living-cost-manager/shared build
RUN pnpm --filter @living-cost-manager/api build
RUN pnpm --filter @living-cost-manager/api deploy --prod --legacy /prod/api
RUN cp -R prisma /prod/api/prisma
RUN cd /prod/api && ./node_modules/.bin/prisma generate --schema=./prisma/schema.prisma

FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV="production"

COPY --from=build /prod/api ./

EXPOSE 4000

CMD ["node", "dist/server.js"]
