# Repository-root context; no environment files or private material copied.
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY backend/main.ts backend/build.mjs backend/tsconfig.json ./
COPY backend/billingTransport.ts ./
COPY shared/billingDispatch.ts /app/shared/billingDispatch.ts
COPY web/lib /app/web/lib
COPY desktop/src/shared /app/desktop/src/shared
RUN npm run typecheck && npm run build
RUN npm prune --omit=dev --ignore-scripts
FROM node:24.12.0-bookworm-slim
ENV NODE_ENV=production PORT=10000
WORKDIR /app
COPY --from=build --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/package.json ./package.json
USER node
EXPOSE 10000
CMD ["node","dist/main.js"]
