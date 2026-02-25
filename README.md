<p align="center">
  <img src="assets/logo.png" alt="ForkOff Logo" width="200"/>
</p>

<h1 align="center">ForkOff Backend</h1>

<p align="center">
  <strong>Real-time API server powering the ForkOff ecosystem</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#api-reference">API Reference</a> •
  <a href="#websocket-events">WebSocket</a>
</p>

---

## Features

- 🔐 **Secure Authentication** - JWT-based auth via Supabase
- 📡 **Real-time Communication** - WebSocket support for instant updates
- 📱 **Device Management** - Pair and manage multiple development machines
- 💬 **Claude Session Handling** - Manage AI coding sessions across devices
- 📊 **Analytics & Tracking** - Token usage, session history, achievements
- 🔔 **Push Notifications** - Expo push notifications for mobile alerts
- ⏰ **Prompt Queue** - Queue and schedule prompts during rate limits

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **NestJS** | Backend framework |
| **PostgreSQL** | Database (via Supabase) |
| **Prisma** | ORM & database toolkit |
| **Socket.io** | Real-time WebSocket communication |
| **Supabase** | Auth & database hosting |
| **Swagger** | API documentation |

---

## Quick Start

### Prerequisites

- Node.js 18+
- Supabase account with a project

### 1. Clone & Install

```bash
git clone https://github.com/Forkoff-app/forkoff-backend.git
cd forkoff-backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your Supabase credentials:

| Variable | Where to Find |
|----------|---------------|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string (pooling) |
| `DIRECT_URL` | Supabase → Project Settings → Database → Connection string (direct) |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon public |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role |
| `JWT_SECRET` | Supabase → Project Settings → API → JWT Secret |

### 3. Setup Database

```bash
# Push schema to database
npm run db:push

# Seed achievements (optional)
npm run db:seed
```

### 4. Start Server

```bash
# Development (hot reload)
npm run start:dev

# Production
npm run build && npm run start:prod
```

Server runs at `http://localhost:3000`

📚 **API Docs**: `http://localhost:3000/docs`

---

## API Reference

### Authentication

All endpoints require a Bearer token (except device registration):

```http
Authorization: Bearer <supabase-jwt-token>
```

### Core Endpoints

#### Devices

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/devices` | List user's devices |
| `GET` | `/api/devices/:id` | Get device details |
| `POST` | `/api/devices/register` | Generate pairing code (CLI) |
| `POST` | `/api/devices/pair` | Pair with code (mobile) |
| `PATCH` | `/api/devices/:id` | Update device |
| `DELETE` | `/api/devices/:id` | Remove device |

#### Claude Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/claude-sessions/device/:deviceId` | Get sessions for device |
| `GET` | `/api/claude-sessions/:sessionId` | Get session details |
| `DELETE` | `/api/claude-sessions/:sessionId` | Delete session |

#### Prompt Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/queue` | Get queued prompts |
| `POST` | `/api/queue` | Add prompt to queue |
| `DELETE` | `/api/queue/:id` | Cancel queued prompt |
| `GET` | `/api/queue/schedule` | Get queue schedule |
| `PATCH` | `/api/queue/schedule` | Update schedule |

#### Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/analytics/usage` | Get usage summary |
| `GET` | `/api/analytics/daily` | Get daily breakdown |
| `GET` | `/api/achievements` | List all achievements |
| `GET` | `/api/achievements/user` | Get user's achievements |

---

## WebSocket Events

Connect to `ws://localhost:3000` with authentication:

```typescript
import { io } from 'socket.io-client';

const socket = io('ws://localhost:3000', {
  auth: { token: 'your-jwt-token' }
});
```

### Mobile App Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `device_status` | Server → Client | Device online/offline status |
| `claude_message` | Server → Client | AI response streaming |
| `claude_approval_request` | Server → Client | Permission request from CLI |
| `achievement_unlocked` | Server → Client | New achievement earned |
| `prompt_queued` | Server → Client | Prompt added to queue |

### CLI Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `claude_session_update` | CLI → Server | Session state changed |
| `user_message` | Server → CLI | Message from mobile app |
| `claude_approval_response` | Server → CLI | Approval decision |

---

## Device Pairing Flow

```
┌─────────────┐                    ┌─────────────┐                    ┌─────────────┐
│     CLI     │                    │   Server    │                    │  Mobile App │
└──────┬──────┘                    └──────┬──────┘                    └──────┬──────┘
       │                                  │                                  │
       │ POST /devices/register           │                                  │
       │─────────────────────────────────>│                                  │
       │                                  │                                  │
       │ { pairingCode: "ABC123" }        │                                  │
       │<─────────────────────────────────│                                  │
       │                                  │                                  │
       │ Display QR Code                  │                                  │
       │                                  │                                  │
       │                                  │     POST /devices/pair           │
       │                                  │<─────────────────────────────────│
       │                                  │                                  │
       │                                  │     { device: {...} }            │
       │                                  │─────────────────────────────────>│
       │                                  │                                  │
       │ WebSocket: device_paired         │                                  │
       │<─────────────────────────────────│                                  │
       │                                  │                                  │
```

---

## Development

### Database Commands

```bash
# Generate Prisma client
npm run db:generate

# Push schema changes
npm run db:push

# Open Prisma Studio
npm run db:studio

# Create migration
npm run db:migrate
```

### Testing with Mobile App

1. Get your local IP:
   - Windows: `ipconfig`
   - macOS/Linux: `ifconfig` or `ip addr`

2. Update mobile app `.env`:
   ```
   EXPO_PUBLIC_API_URL=http://YOUR_IP:3000/api
   EXPO_PUBLIC_WS_URL=ws://YOUR_IP:3000
   ```

3. Start both servers

---

## Project Structure

```
src/
├── auth/           # Authentication & user profile
├── devices/        # Device management & pairing
├── claude-sessions/# Claude session handling
├── terminal/       # Terminal sessions
├── prompt-queue/   # Queue management
├── analytics/      # Usage analytics
├── achievements/   # Gamification
├── notifications/  # Push notifications
├── websocket/      # WebSocket gateway (real-time relay)
├── app-config/     # App version checks & feature flags
├── config/         # Secrets management (AWS Secrets Manager)
├── crypto/         # E2EE key exchange support
├── geo-ip/         # GeoIP country detection
├── health/         # Health check endpoint
├── logging/        # Winston logging & exception filters
└── prisma/         # Database client & schema
```

---

## Related Projects

- [ForkOff Mobile App](https://github.com/Forkoff-app/forkoff-react-native) - React Native app
- [ForkOff CLI](https://github.com/Forkoff-app/forkoff-cli) - Command line tool
- [ForkOff Website](https://github.com/Forkoff-app/forkoff-website) - Landing page

---

<p align="center">
  Made with ❤️ by the ForkOff team
</p>
