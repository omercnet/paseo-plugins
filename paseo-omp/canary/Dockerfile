# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS plugin-build
WORKDIR /src/paseo-plugins
COPY package.json bun.lock .
COPY paseo-omp ./paseo-omp
WORKDIR /src/paseo-plugins/paseo-omp
RUN tarball="$(mktemp /tmp/paseo-omp-XXXXXX.tgz)" && \
  bun pm pack --ignore-scripts --filename "$tarball" && \
  mkdir -p /opt/paseo-omp && \
  tar -xzf "$tarball" -C /opt/paseo-omp --strip-components=1 && \
  cd /opt/paseo-omp && \
  bun install --production --ignore-scripts

FROM ghcr.io/getpaseo/paseo:0.9.2@sha256:d413ff361bc4018d559da3d517a6d5a9eaca721fbb1b71ae8df3dcf7a965c136

ARG TARGETARCH
ARG OMP_VERSION=18.1.15
ARG OMP_SHA256_AMD64=747518a41fbb32ac47491b4677a7a921d0d9e5977ae006c358d6836813149adc
ARG OMP_SHA256_ARM64=2e1142ccd4bb76413b63a05711ac51c7b95551f36387ef295661bb86f0576189

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN git config --system --add safe.directory /workspace/paseo-plugins
COPY --from=plugin-build --chown=1000:1000 /opt/paseo-omp /opt/paseo-omp
COPY --chown=1000:1000 paseo-omp/canary/protocol-violation-peer.mjs /opt/paseo-omp/canary/protocol-violation-peer.mjs
COPY --chown=1000:1000 paseo-omp/canary/mcp-server.ts /opt/paseo-omp/canary/mcp-server.ts
RUN test -f /opt/paseo-omp/canary/protocol-violation-peer.mjs \
  && test -f /opt/paseo-omp/canary/mcp-server.ts
COPY --chown=1000:1000 paseo-omp/canary/paseo.config.json /home/paseo/.paseo/config.json
COPY --chown=1000:1000 paseo-omp/canary/models.yml /home/paseo/.omp/agent/models.yml
COPY --chown=1000:1000 paseo-omp/canary/omp.config.yml /home/paseo/.omp/agent/config.yml
RUN case "${TARGETARCH}" in \
      amd64) omp_asset="omp-linux-x64"; omp_sha="${OMP_SHA256_AMD64}" ;; \
      arm64) omp_asset="omp-linux-arm64"; omp_sha="${OMP_SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && test -n "${omp_sha}" \
  && curl --fail --location --retry 3 --max-time 300 \
    "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/${omp_asset}" \
    --output /usr/local/bin/omp \
  && echo "${omp_sha}  /usr/local/bin/omp" | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/omp \
  && test "$(/usr/local/bin/omp --version)" = "omp/${OMP_VERSION}"
