FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tcpdump \
    tshark \
    iproute2 \
    dnsutils \
    ca-certificates \
    git \
    jq \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the pre-built opencode binary
COPY opencode /usr/local/bin/opencode
RUN chmod +x /usr/local/bin/opencode

# Create workspace and config
RUN mkdir -p /workspace /root/.config/opencode
WORKDIR /workspace

# Init a git repo (opencode requires one)
RUN git init && git config user.email "test@test.com" && git config user.name "test"

# Copy config and test script
COPY opencode.json /workspace/opencode.json
COPY test-traffic.sh /usr/local/bin/test-traffic.sh
RUN chmod +x /usr/local/bin/test-traffic.sh

ENTRYPOINT ["/usr/local/bin/test-traffic.sh"]
