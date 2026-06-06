FROM node:22-alpine

WORKDIR /app

# Install frontend deps + build dist
COPY bitget-agent-demo/frontend/package*.json ./frontend/
RUN cd frontend && npm install
COPY bitget-agent-demo/frontend/ ./frontend/
RUN cd frontend && npm run build

# Install backend deps
COPY bitget-agent-demo/backend/package*.json ./backend/
RUN cd backend && npm install
COPY bitget-agent-demo/backend/ ./backend/

# Demo-bot (shared dependency)
COPY demo-bot/ ./demo-bot/

EXPOSE 3001
CMD ["node", "backend/server.js"]
