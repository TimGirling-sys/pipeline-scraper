# Dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcb1 libxcomposite1 \
    libxdamage1 libxfixes3 libgbm1 libpango-1.0-0 libcairo2 libasound2 libxrandr2 \
    fonts-liberation libxshmfence1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY src ./src
COPY eslint.config.mjs .
COPY README.md .

RUN npm run postinstall

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
