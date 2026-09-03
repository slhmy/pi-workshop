FROM node:22-alpine

ARG PI_VERSION=0.84.4

LABEL org.opencontainers.image.source="https://github.com/slhmy/pi-workshop" \
      org.opencontainers.image.description="A self-hosted Web control surface for Pi" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache bash build-base ca-certificates chromium curl git github-cli jq \
      libc6-compat openssh-client procps python3 py3-pip ripgrep tmux \
    && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"

WORKDIR /opt/pi-control

COPY --chown=node:node control/server.mjs control/acceptance.mjs control/CORE.md ./

RUN mkdir -p /agent-data/workspace/web /agent-data/config /agent-data/sessions \
    && chown -R node:node /agent-data

COPY --chown=node:node AGENTS.md .gitignore /agent-data/workspace/
COPY --chown=node:node web/ /agent-data/workspace/web/

VOLUME ["/agent-data"]

USER node

ENV NODE_ENV=production \
    HOME=/agent-data \
    PORT=3000 \
    PATH=/agent-data/.local/bin:$PATH \
    NPM_CONFIG_PREFIX=/agent-data/.local \
    PYTHONUSERBASE=/agent-data/.local \
    PIP_CACHE_DIR=/agent-data/.cache/pip \
    WORKSPACE_DIR=/agent-data/workspace \
    PI_CODING_AGENT_DIR=/agent-data/config \
    PI_CODING_AGENT_SESSION_DIR=/agent-data/sessions \
    PI_THINKING=high \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

EXPOSE 3000

CMD ["node", "/opt/pi-control/server.mjs"]
