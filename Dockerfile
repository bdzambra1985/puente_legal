FROM node:20-alpine

# poppler-utils aporta `pdftocairo`, usado para convertir los comprobantes
# en PDF a imagen (primera página) y que se puedan ver en el panel admin.
RUN apk add --no-cache poppler-utils

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
