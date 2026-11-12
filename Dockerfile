FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@12.5.1 --allow-scripts=pnpm@12.5.1 --strict-allow-scripts
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY tools/image-deps.mjs ./tools/image-deps.mjs
RUN pnpm build && node tools/image-deps.mjs && pnpm prune --prod

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cc66d222f0a7ec996b78a99fe76a969bc80b539a5016ad866c14d1949bc6d0ab
ARG VCS_REF
ARG SOURCE_SHA256
LABEL org.opencontainers.image.source="https://github.com/stanimirivanov/fleetiq-simulator" \
      org.opencontainers.image.revision="${VCS_REF}" \
      com.fleetiq.source.sha256="${SOURCE_SHA256}"
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/LICENSE /usr/local/share/licenses/node/LICENSE
WORKDIR /app
COPY LICENSE ./LICENSE
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/cli.js"]
