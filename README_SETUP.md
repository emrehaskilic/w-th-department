# Tele-Codex Setup Guide

This project was set up by Antigravity.

## Prerequisites
- Node.js (v18+)
- npm

## Environment
Create `server/.env` from `server/.env.example` and set:

```bash
API_KEY_SECRET=your-strong-api-key
```

Optional frontend env (`.env.local`):

```bash
VITE_PROXY_API_KEY=your-strong-api-key
```

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
