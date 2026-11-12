# DataDice para hospedagem. Os dados ficam no PostgreSQL (DATABASE_URL); o contêiner não guarda nada.
# Versão fixa do Node: a mesma imagem sempre (atualize de propósito, testando antes).
FROM node:22.14.0-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TRUST_PROXY=1

WORKDIR /app

# Só as dependências de produção (o SQLite fica de fora: ele serve só para importar dados antigos).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY public ./public

# Sem permissões de administrador dentro do contêiner.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "index.js"]
