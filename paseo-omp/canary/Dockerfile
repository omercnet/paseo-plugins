# syntax=docker/dockerfile:1.7

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS plugin-build
WORKDIR /src/paseo-omp
COPY paseo-omp/package.json paseo-omp/package-lock.json ./
RUN npm ci --ignore-scripts
COPY paseo-omp/ ./

FROM ghcr.io/getpaseo/paseo:0.9.0-beta.1@sha256:f75a0eb3547ad3cc6bbdeaa7277d2d50eb4d06a9dd669d480371d7adf1c911b5

ARG TARGETARCH
ARG OMP_VERSION=18.1.15
ARG OMP_SHA256_AMD64=747518a41fbb32ac47491b4677a7a921d0d9e5977ae006c358d6836813149adc
ARG OMP_SHA256_ARM64=2e1142ccd4bb76413b63a05711ac51c7b95551f36387ef295661bb86f0576189

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=plugin-build --chown=1000:1000 /src/paseo-omp /opt/paseo-omp
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

ENV PASEO_WEB_UI_ENABLED=true
ENV PASEO_LISTEN=0.0.0.0:6767
ENV PASEO_RELAY_ENABLED=false
