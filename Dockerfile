# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.23.1-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /opt/mandate
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOME=/home/mandate

RUN groupadd --gid 10001 mandate \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/mandate --shell /usr/sbin/nologin mandate

WORKDIR /opt/mandate
COPY --from=dependencies --chown=10001:10001 /opt/mandate/node_modules ./node_modules
COPY --chown=10001:10001 package.json package-lock.json LICENSE openapi.yaml ./
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 scripts ./scripts
COPY --chown=10001:10001 migrations ./migrations
COPY --chown=10001:10001 packages ./packages
COPY --chown=10001:10001 deployment ./deployment
COPY --chmod=0555 deployment/container-entrypoint.sh /usr/local/bin/mandate-entrypoint

USER 10001:10001
EXPOSE 8787 8788 8789
ENTRYPOINT ["/usr/local/bin/mandate-entrypoint"]
CMD ["node", "src/server.js"]
