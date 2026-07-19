FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
    rsync \
    tar \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install the Bitwarden Secrets Manager CLI for deploy-time secret rendering.
ARG BWS_VERSION=1.0.0
ARG BWS_SHA256_AMD64=9077fb7b336a62abc8194728fea8753afad8b0baa3a18723fc05fc02fdb53568
ARG BWS_SHA256_ARM64=20a3dcb9e3ce7716a1dc3c0e1c76cea9d5e2bf75094cbb5aad54ced4304929cb
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) bws_arch=x86_64-unknown-linux-gnu; bws_sha256="$BWS_SHA256_AMD64" ;; \
      arm64) bws_arch=aarch64-unknown-linux-gnu; bws_sha256="$BWS_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture for bws: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v${BWS_VERSION}/bws-${bws_arch}-${BWS_VERSION}.zip" \
      -o /tmp/bws.zip; \
    echo "$bws_sha256  /tmp/bws.zip" | sha256sum -c -; \
    unzip /tmp/bws.zip -d /usr/local/bin bws; \
    chmod +x /usr/local/bin/bws; \
    rm /tmp/bws.zip; \
    bws --version

# Install Gitleaks for repo secret scanning in the same validation container.
ARG GITLEAKS_VERSION=8.24.3
ARG GITLEAKS_SHA256_AMD64=9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c
ARG GITLEAKS_SHA256_ARM64=5f2edbe1f49f7b920f9e06e90759947d3c5dfc16f752fb93aaafc17e9d14cf07
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gitleaks_arch=x64; gitleaks_sha256="$GITLEAKS_SHA256_AMD64" ;; \
      arm64) gitleaks_arch=arm64; gitleaks_sha256="$GITLEAKS_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture for gitleaks: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" \
      -o /tmp/gitleaks.tar.gz; \
    echo "$gitleaks_sha256  /tmp/gitleaks.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
    rm /tmp/gitleaks.tar.gz; \
    gitleaks version

# Install Ansible and validation tooling.
RUN pip install --no-cache-dir \
    ansible-core \
    ansible-lint \
    && rm -rf /root/.cache

# Set up working directory
WORKDIR /ansible

# Copy ansible config
COPY ansible.cfg /etc/ansible/ansible.cfg

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["ansible", "--version"]
