# Runs the Memory Vault MCP server over HTTP (Streamable HTTP on $VAULT_PORT,
# default 8787). For stdio transport run: node server.mjs stdio
FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs index.mjs ./
COPY src ./src
ENV MEMORY_DIR=/data
ENV VAULT_HOST=0.0.0.0
VOLUME /data
EXPOSE 8787
CMD ["node", "server.mjs"]
