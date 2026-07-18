FROM python:3.12-slim

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
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) bws_arch=x86_64-unknown-linux-gnu ;; \
      arm64) bws_arch=aarch64-unknown-linux-gnu ;; \
      *) echo "Unsupported architecture for bws: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v${BWS_VERSION}/bws-${bws_arch}-${BWS_VERSION}.zip" \
      -o /tmp/bws.zip; \
    unzip /tmp/bws.zip -d /usr/local/bin bws; \
    chmod +x /usr/local/bin/bws; \
    rm /tmp/bws.zip; \
    bws --version

# Install Gitleaks for repo secret scanning in the same validation container.
ARG GITLEAKS_VERSION=8.24.3
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gitleaks_arch=x64 ;; \
      arm64) gitleaks_arch=arm64 ;; \
      *) echo "Unsupported architecture for gitleaks: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" \
      -o /tmp/gitleaks.tar.gz; \
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
