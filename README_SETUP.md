# Tele-Codex Setup Guide

This project was set up by Antigravity.

## Prerequisites
- Node.js (v18+)
- npm

## Environment
Create `server/.env` from `server/.env.example` and set:

```bash
API_KEY_SECRET=your-strong-api-key
LOG_LEVEL=info
```

Optional frontend env (`.env.local`):

```bash
VITE_PROXY_API_KEY=your-strong-api-key
```

`VITE_PROXY_API_KEY` is required. Frontend startup fails fast when it is missing.

Optional dev host override (`.env.development.local`):

```bash
VITE_DEV_SERVER_HOST=0.0.0.0
```

By default, Vite binds to `localhost` for safer local development.

## Start the Project
To start both the frontend and backend servers concurrently:

```bash
npm run dev:all
```

## Access the Application
- Frontend: http://localhost:5174
- Backend API: http://localhost:8787

## Project Structure
- `src/`: Frontend React application
- `server/`: Backend Express/WebSocket server
