FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node server.js package.json ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node install.sh install.ps1 ./
RUN mkdir -p /data && chown node:node /data

ENV HOST=0.0.0.0 \
    PORT=8080 \
    WADDLE_DATA=/data \
    WADDLE_PROFILE=small \
    NODE_OPTIONS=--max-old-space-size=320
EXPOSE 8080
VOLUME ["/data"]
USER node
CMD ["node", "server.js"]
