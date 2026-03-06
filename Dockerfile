FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production \
  && apk add --no-cache ffmpeg

COPY . .

ENV PORT=3510
EXPOSE 3510

CMD ["node", "server.js"]
