FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./

ENV PORT=4001
EXPOSE 4001

CMD ["node", "server.js"]
