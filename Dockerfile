FROM node:22-alpine
ENV NODE_ENV=production TZ=America/Sao_Paulo PORT=3000
RUN apk add --no-cache tzdata
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
