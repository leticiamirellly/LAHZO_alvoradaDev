FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json tsconfig.base.json vitest.config.ts ./
RUN npm install
RUN npm run db:generate

FROM base AS api
EXPOSE 3000
CMD ["sh", "-c", "npm run db:deploy && npm -w @app/api run dev"]

FROM base AS worker
CMD ["sh", "-c", "npm run db:deploy && npm -w @app/worker run dev"]

FROM base AS admin
EXPOSE 5173
CMD ["npm", "-w", "@app/admin", "run", "dev", "--", "--host", "0.0.0.0"]
