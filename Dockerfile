FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY conhecimento ./conhecimento
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
