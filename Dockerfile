FROM oven/bun:1.2

WORKDIR /app
COPY . .
RUN bun install

USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "server.ts" ]