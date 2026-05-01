FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8080

ENV PROXY_PORT=8080
ENV UPSTREAM_URL=http://host.docker.internal:8001

CMD ["node", "src/index.js"]
