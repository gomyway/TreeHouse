# little-redwood-author: the sandbox the runner starts per authoring job.
# Node 22 + the pi coding agent + jsdom (for harness/smoke.mjs). No secrets in the image:
# FIREWORKS_API_KEY arrives as an env var at `docker run`; pi's Fireworks provider is built in.
#   docker build -t little-redwood-author relay/runner
FROM node:22-slim

ARG PI_VERSION=0.80.3
ARG JSDOM_VERSION=26.1.0

ENV NODE_PATH=/usr/local/lib/node_modules \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN npm install -g --omit=dev --no-audit --no-fund \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" "jsdom@${JSDOM_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

# The node image already has a non-root "node" user (uid 1000).
USER node
RUN mkdir -p /home/node/.pi/agent
WORKDIR /job
CMD ["pi", "--version"]
