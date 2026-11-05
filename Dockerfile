FROM node:24-trixie-slim

# ffmpeg does the live remuxing; the fonts are for the slates and the channel art (Bebas Neue, Montserrat).
# Debian's security updates go in at build time, so a fix released after the base image was published (which
# the Trivy step in CI would otherwise block on) is picked up without waiting for a new node image. CI passes the
# date as APT_DAY so this layer isn't reused from the build cache for more than a day.
ARG APT_DAY=
RUN echo "packages as of ${APT_DAY:-build time}" && apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-bebas-neue fonts-montserrat ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=7000 \
    DATA_DIR=/data \
    HLS_DIR=/tmp/basiccable-hls
VOLUME /data
EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
