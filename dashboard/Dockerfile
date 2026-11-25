FROM docker.io/library/alpine:latest

RUN apk add --no-cache nodejs

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
