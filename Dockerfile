FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
ARG GREENLIGHT_GIT_COMMIT=container-build-unattributed
ENV GREENLIGHT_GIT_COMMIT=$GREENLIGHT_GIT_COMMIT
RUN npm run typecheck \
  && npm test \
  && npm run canary \
  && npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "--experimental-strip-types", "src/server.ts"]
