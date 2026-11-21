FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@12.5.1 --allow-scripts=pnpm@12.5.1 --strict-allow-scripts
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY packaging/image-deps.mjs ./packaging/image-deps.mjs
RUN pnpm build && node packaging/image-deps.mjs && pnpm prune --prod

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cc66d222f0a7ec996b78a99fe76a969bc80b539a5016ad866c14d1949bc6d0ab AS runtime-libraries
FROM gcr.io/distroless/base-nossl-debian13:nonroot@sha256:89815d620ac01d8de13cdaf04d19ed874447ca2296d4985b14b818f6e5e47854
ARG VCS_REF
ARG SOURCE_SHA256
LABEL org.opencontainers.image.source="https://github.com/stanimirivanov/fleetiq-simulator" \
      org.opencontainers.image.revision="${VCS_REF}" \
      com.fleetiq.source.sha256="${SOURCE_SHA256}"
# Node bundles OpenSSL and links dynamically to the GCC runtime libraries.
# Keep Debian package records and licenses with the copied libraries.
COPY --from=runtime-libraries /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 /usr/lib/x86_64-linux-gnu/libgcc_s.so.1
COPY --from=runtime-libraries /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
COPY --from=runtime-libraries /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.33 /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.33
COPY --from=runtime-libraries /var/lib/dpkg/status.d/gcc-14-base /var/lib/dpkg/status.d/gcc-14-base
COPY --from=runtime-libraries /var/lib/dpkg/status.d/gcc-14-base.md5sums /var/lib/dpkg/status.d/gcc-14-base.md5sums
COPY --from=runtime-libraries /var/lib/dpkg/status.d/libgcc-s1 /var/lib/dpkg/status.d/libgcc-s1
COPY --from=runtime-libraries /var/lib/dpkg/status.d/libgcc-s1.md5sums /var/lib/dpkg/status.d/libgcc-s1.md5sums
COPY --from=runtime-libraries /var/lib/dpkg/status.d/libstdc++6 /var/lib/dpkg/status.d/libstdc++6
COPY --from=runtime-libraries /var/lib/dpkg/status.d/libstdc++6.md5sums /var/lib/dpkg/status.d/libstdc++6.md5sums
COPY --from=runtime-libraries /usr/share/doc/gcc-14-base/ /usr/share/doc/gcc-14-base/
COPY --from=runtime-libraries /usr/share/doc/libgcc-s1 /usr/share/doc/libgcc-s1
COPY --from=runtime-libraries /usr/share/doc/libstdc++6 /usr/share/doc/libstdc++6
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/LICENSE /usr/local/share/licenses/node/LICENSE
WORKDIR /app
COPY LICENSE ./LICENSE
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/cli.js"]
