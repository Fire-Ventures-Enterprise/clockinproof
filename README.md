# WorkTracker 🕐

## Project Overview
- **Name**: WorkTracker
- **Goal**: Track work time, hourly rates, and GPS location of workers using phone number/device ID
- **Tech**: Hono + TypeScript + Cloudflare Pages + D1 Database + Leaflet.js Maps

## Live URLs (Development)
- **Worker App**: https://3000-ih378a4crfkzcd0btzudb-18e660f9.sandbox.novita.ai/
- **Admin Dashboard**: https://3000-ih378a4crfkzcd0btzudb-18e660f9.sandbox.novita.ai/admin
- **Admin PIN**: `1234`

## Features ✅
- **Worker Registration** — Register with name + phone number + 4-digit PIN
- **Clock In/Out** — One-tap time tracking with timestamp
- **GPS Location Capture** — Auto-capture GPS coordinates on clock in/out
- **Reverse Geocoding** — Address lookup via OpenStreetMap Nominatim
- **Interactive Map** — Leaflet.js map showing current position
- **Hourly Rate Tracking** — Set rate per worker, auto-calculate earnings
- **Live Session Timer** — Real-time duration + earnings counter while clocked in
- **Location Pings** — Auto-ping GPS every 5 minutes while working
- **Admin Dashboard** — View all workers, sessions, live activity
- **Map View (Admin)** — See all worker clock-in locations on a map
- **CSV Export** — Download session data as spreadsheet
- **Period Filters** — Today / Week / Month / All time stats
- **Mobile-First UI** — Designed for phone use in the field

## API Endpoints

### Workers
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workers/register` | Register or find worker |
| GET | `/api/workers/lookup/:phone` | Find worker by phone |
| GET | `/api/workers` | List all workers (admin) |
| PUT | `/api/workers/:id` | Update worker rate/info |
| DELETE | `/api/workers/:id` | Remove worker |

### Sessions (Clock In/Out)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sessions/clock-in` | Clock in with GPS |
| POST | `/api/sessions/clock-out` | Clock out with GPS |
| GET | `/api/sessions/status/:worker_id` | Check if clocked in |
| GET | `/api/sessions/worker/:worker_id` | Worker session history |
| GET | `/api/sessions/active` | All active sessions (admin) |
| GET | `/api/sessions?date=YYYY-MM-DD` | Filtered sessions |

### Location
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/location/ping` | Submit GPS ping |
| GET | `/api/location/session/:session_id` | Get location trail |

### Stats & Settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats/summary?period=today` | Summary stats |
| GET | `/api/stats/worker/:worker_id` | Per-worker stats |
| GET | `/api/settings` | App settings |
| PUT | `/api/settings` | Update settings |

## Data Models

### Workers
```
id, name, phone (unique), device_id, hourly_rate, role, active, pin, created_at
```

### Sessions
```
id, worker_id, clock_in_time, clock_out_time, clock_in_lat/lng/address, 
clock_out_lat/lng/address, total_hours, earnings, status, notes, created_at
```

### Location Pings
```
id, session_id, worker_id, latitude, longitude, accuracy, timestamp
```

## User Guide

### For Workers (Mobile):
1. Open the app URL on phone
2. Register with your **name + phone number + PIN**
3. Tap **Clock In** — app captures your GPS location
4. See live timer + earnings while working
5. Tap **Clock Out** when done

### For Admin:
1. Go to `/admin`
2. Enter PIN: `1234`
3. View **Live View** — see who's working right now
4. View **Workers** tab — manage all workers & rates
5. View **Sessions** tab — full history, filter by date, export CSV
6. View **Map** tab — see clock-in locations on map

## Deployment
- **Platform**: Cloudflare Pages + D1 Database
- **Status**: ✅ Running in development
- **Tech Stack**: Hono + TypeScript + TailwindCSS + Leaflet.js + D1 SQLite
- **Last Updated**: 2026-02-27

## Local Development
```bash
npm run db:migrate:local   # Apply migrations
npm run db:seed            # Add sample data
npm run build              # Build project
pm2 start ecosystem.config.cjs  # Start server
```
