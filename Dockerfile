# syntax=docker/dockerfile:1
ARG NODE_VERSION=26.9.0

FROM node:${NODE_VERSION}-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/webapp/package.json packages/webapp/
RUN npm ci
COPY packages packages
RUN npm run build

FROM node:${NODE_VERSION}-alpine3.24
RUN apk add --no-cache ffmpeg \
 && mkdir /config /data \
 && chown node:node /config /data
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/webapp/package.json packages/webapp/
RUN npm ci --omit=dev --workspace @ladarr/server
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY --from=build /app/packages/webapp/dist packages/webapp/dist

# The update from the settings downloads a bundle into /app, so the user of the process must write there.
RUN chown -R node:node /app

ENV NODE_ENV=production \
    PORT=3000 \
    LADARR_CONFIG_DIR=/config \
    LADARR_WEB_DIR=/app/packages/webapp/dist
USER node
EXPOSE 3000 8989 7878 5055
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "packages/server/src/system/healthcheck.ts"]
CMD ["node", "packages/server/src/index.ts"]
