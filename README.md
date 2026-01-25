# ForkOff API

Backend API for the ForkOff mobile app with real-time WebSocket support.

## Tech Stack

- **Framework**: NestJS
- **Database**: PostgreSQL (Supabase)
- **ORM**: Prisma
- **WebSocket**: Socket.io
- **Auth**: JWT (Supabase tokens)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

You'll need:
- **DATABASE_URL**: From Supabase > Project Settings > Database > Connection string (pooling)
- **DIRECT_URL**: From Supabase > Project Settings > Database > Connection string (direct)
- **JWT_SECRET**: From Supabase > Project Settings > API > JWT Secret

### 3. Push Database Schema

```bash
npm run db:push
```

This creates the tables in your Supabase PostgreSQL database.

### 4. Start the Server

```bash
# Development (with hot reload)
npm run start:dev

# Production
npm run build
npm run start:prod
```

The API will be available at `http://localhost:3000`.

## API Endpoints

### Authentication
All endpoints (except device registration) require a Bearer token from Supabase Auth.

```
Authorization: Bearer <supabase-jwt-token>
```

### Devices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/devices | List all devices for user |
| GET | /api/devices/:id | Get single device |
| POST | /api/devices | Create device directly |
| POST | /api/devices/register | Generate pairing code (from CLI) |
| POST | /api/devices/pair | Pair device with code (from mobile) |
| PATCH | /api/devices/:id | Update device (rename) |
| DELETE | /api/devices/:id | Remove device |
| POST | /api/devices/:id/refresh | Refresh device status |

### User Profile

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/auth/me | Get current user profile |
| PATCH | /api/auth/me | Update user profile |

## WebSocket Events

Connect to `ws://localhost:3000` with the Supabase JWT token.

### Client -> Server

```typescript
// Authenticate (sent in handshake)
{ auth: { token: 'jwt-token' } }

// Subscribe to device updates
socket.emit('subscribe_device', { deviceId: 'device-id' });

// Unsubscribe from device updates
socket.emit('unsubscribe_device', { deviceId: 'device-id' });
```

### Server -> Client

```typescript
// Device status changed
socket.on('device_status', (data) => {
  // { deviceId: string, status: 'ONLINE' | 'OFFLINE' | 'SYNCING' }
});
```

### Device (CLI) Events

When connecting from a CLI tool on a computer:

```typescript
// Connect with device ID
const socket = io('ws://localhost:3000', {
  auth: { deviceId: 'device-id' }
});

// Send heartbeat
socket.emit('device_heartbeat', { status: 'ONLINE' });

// Report syncing status
socket.emit('device_syncing', { syncing: true });
```

## Device Pairing Flow

1. **On Computer (CLI)**:
   - Call `POST /api/devices/register` with device info
   - Display the returned pairing code as QR code
   - Connect to WebSocket with device ID

2. **On Mobile App**:
   - Scan QR code to get pairing code
   - Call `POST /api/devices/pair` with the code
   - Device is now linked to user's account

## Development

```bash
# Generate Prisma client after schema changes
npm run db:generate

# Push schema changes to database
npm run db:push

# Create migration
npm run db:migrate

# Open Prisma Studio (database viewer)
npm run db:studio
```

## Testing with Mobile App

1. Get your computer's local IP address:
   - Windows: `ipconfig`
   - Mac/Linux: `ifconfig`

2. Update the mobile app's `.env`:
   ```
   EXPO_PUBLIC_API_URL=http://YOUR_IP:3000/api
   EXPO_PUBLIC_WS_URL=ws://YOUR_IP:3000
   EXPO_PUBLIC_USE_MOCKS=false
   ```

3. Start the API server and mobile app together.
