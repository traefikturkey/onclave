#!/bin/bash
# Entrypoint script to fix SSH key permissions from mounted volume

# Copy SSH keys from mounted volume to a writable location with correct permissions
if [ -d /mnt/ssh ]; then
    mkdir -p /root/.ssh
    cp -r /mnt/ssh/* /root/.ssh/ 2>/dev/null || true
    chmod 700 /root/.ssh
    chmod 600 /root/.ssh/* 2>/dev/null || true
    chmod 644 /root/.ssh/*.pub 2>/dev/null || true
    chmod 644 /root/.ssh/known_hosts 2>/dev/null || true
    # config file needs 600
    chmod 600 /root/.ssh/config 2>/dev/null || true
fi

# Execute the command passed to the container
exec "$@"
