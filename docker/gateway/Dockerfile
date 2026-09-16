# Pinned: openclaw 2026.9.4 requires node >=24.16.0 <25 (or >=26.1.0).
# The floating node:24 tag would satisfy that today but is not reproducible.
FROM node:24.18
RUN apt-get update && apt-get install -y git socat && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@2026.9.4
# Default the Control UI language to English (see patch-control-ui.sh).
COPY patch-control-ui.sh /patch-control-ui.sh
RUN sh /patch-control-ui.sh && rm /patch-control-ui.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
