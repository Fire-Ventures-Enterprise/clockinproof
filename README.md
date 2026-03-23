# ClockInProof

**clockinproof.com** — GPS-verified workforce time tracking with geofence fraud prevention.

## Project Overview
- **Name**: ClockInProof
- **Domain**: clockinproof.com
- **Goal**: Prove workers clocked in at the right place, at the right time — with GPS verification, geofence enforcement, and a full audit trail.
- **Tech**: Hono + TypeScript + Cloudflare Pages + D1 Database + Leaflet.js Maps + Twilio SMS

## Live URLs (Development Sandbox)
- **Worker App**: https://3000-ih378a4crfkzcd0btzudb-18e660f9.sandbox.novita.ai/
- **Admin Dashboard**: https://3000-ih378a4crfkzcd0btzudb-18e660f9.sandbox.novita.ai/admin
- **Admin PIN**: `1234`

## Features ✅

### GPS & Geofence
- **GPS Fraud Detection** — Blocks clock-in if worker is outside the job-site geofence
- **Geofence Radius** — Configurable per-job (100m / 300m / 500m / 1km presets)
- **Drift Detection** — Flags worker if they leave the site after clocking in
- **Location Pings** — Auto-ping GPS every 5 minutes while clocked in

### Shift Guardrails (Auto Clock-Out)
- **Max Shift** — Auto clock-out after configurable max hours (default 10h)
- **End of Day** — Auto clock-out 30 min after work end time if forgotten
- **Geofence Exit** — Auto clock-out after worker is outside geofence for X minutes (configurable)
- **Idle/Away Warning** — Flag session if no GPS ping received for X minutes

### Admin Controls
- **Force Clock-Out** — Admin can manually stop any worker's clock from Live tab or Worker Drawer
- **Bulk Clock-Out** — One-click stop for all workers outside the geofence
- **Admin Override** — Approve or deny clock-in requests from outside the geofence
- **Override Notifications** — Email (Resend) and SMS (Twilio) alerts when override needed

### Tracking & Reporting
- **Worker Registration** — Register with name + phone + 4-digit PIN
- **Clock In/Out** — One-tap with GPS + job location + task description
- **Live Session Timer** — Real-time duration + earnings counter
- **Hourly Rate Tracking** — Per-worker rate, auto-calculate earnings
- **Admin Dashboard** — Live view, Workers, Sessions, Map, Calendar, Export
- **Calendar View** — Month calendar with shift history per worker
- **CSV Export** — Payroll-ready export with earnings per worker/period
- **Statutory Pay** — Canadian + US jurisdiction multipliers

### Notifications
- **Email Alerts** — Rich HTML email via Resend API
- **SMS Alerts** — Text messages via Twilio
- **Auto Clock-Out Alerts** — Admin notified of every automatic clock-out

## API Endpoints

### Workers
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workers/register` | Register or find worker |
| GET | `/api/workers/lookup/:phone` | Find worker by phone |
| GET | `/api/workers` | List all workers (admin) |
| PUT | `/api/workers/:id` | Update worker info |
| DELETE | `/api/workers/:id` | Remove worker |

### Sessions
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sessions/clock-in` | Clock in with GPS + fraud check |
| POST | `/api/sessions/clock-out` | Clock out with GPS |
| POST | `/api/sessions/:id/admin-clockout` | Admin force clock-out |
| POST | `/api/sessions/clockout-drifted` | Bulk clock-out all drifted workers |
| GET | `/api/sessions/watchdog` | Run guardrail checks (auto clock-outs) |
| GET | `/api/sessions/status/:worker_id` | Check if clocked in |
| GET | `/api/sessions/active` | All active sessions (admin live view) |
| GET | `/api/sessions?date=YYYY-MM-DD` | Filtered session history |

### Override (GPS Fraud)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/override/:id/approve` | Admin approves override |
| POST | `/api/override/:id/deny` | Admin denies override |
| GET | `/api/override/pending` | List pending overrides |

### Stats & Settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats/summary?period=today` | Summary stats (today/week/month/all) |
| GET | `/api/settings` | App settings |
| PUT | `/api/settings` | Update settings |

## Data Models

### Workers
```
id, name, phone (unique), hourly_rate, role, active, pin, currently_clocked_in
```

### Sessions
```
id, worker_id, clock_in_time, clock_out_time,
clock_in_lat/lng/address, clock_out_lat/lng/address,
total_hours, earnings, status, notes,
drift_flag, drift_distance_meters, drift_detected_at,
away_flag, away_since,
auto_clockout, auto_clockout_reason,
job_location, job_lat, job_lng, job_description
```

### Settings (key-value store)
```
app_name, admin_pin, admin_email, admin_phone,
hourly_rate, work_start, work_end, work_days,
gps_fraud_check, geofence_radius_meters,
max_shift_hours, away_warning_min, auto_clockout_enabled,
geofence_exit_clockout_min,
notify_email, notify_sms,
twilio_account_sid, twilio_auth_token, twilio_from_number,
resend_api_key, app_host, country, province, timezone
```

## User Guide

### For Workers (Mobile):
1. Open **clockinproof.com** on your phone
2. Register with your **name + phone number + PIN**
3. Tap **Clock In** → enter the job address and task
4. App verifies your GPS is within the geofence of the job site
5. See live timer + earnings while working
6. Tap **Clock Out** when done
7. If you forget — the admin or the system will auto-clock you out

### For Admin:
1. Go to **clockinproof.com/admin**
2. Enter PIN (default: `1234`, change in Settings)
3. **Live Tab** — see who's working right now, force clock-out any worker
4. **Workers Tab** — add/manage workers, set hourly rates, click any worker for full history
5. **Sessions Tab** — full history, filter by date/worker, export CSV
6. **Map Tab** — see all clock-in locations on a map
7. **Calendar Tab** — month-by-month shift view per worker
8. **Overrides Tab** — approve or deny workers outside the geofence
9. **Settings Tab** — configure geofence, guardrails, Twilio SMS, notifications

## Deployment
- **Platform**: Cloudflare Pages + D1 Database
- **Domain**: clockinproof.com (point CNAME to Cloudflare Pages)
- **Status**: ✅ Active in development sandbox
- **Tech Stack**: Hono + TypeScript + TailwindCSS CDN + Leaflet.js + D1 SQLite
- **Last Updated**: 2026-02-28

## Cloudflare Deployment
```bash
npm run build                    # Build project
npx wrangler d1 create clockinproof-production  # Create D1 database
npx wrangler pages deploy dist --project-name clockinproof
```

## Local Development
```bash
npm run db:migrate:local   # Apply migrations
npm run build              # Build project
pm2 start ecosystem.config.cjs  # Start server on port 3000
```

## Required Secrets (Cloudflare)
```
TWILIO_ACCOUNT_SID    # From Twilio Console
TWILIO_AUTH_TOKEN     # From Twilio Console
TWILIO_FROM_NUMBER    # Your Twilio phone number (+1XXXXXXXXXX)
RESEND_API_KEY        # From resend.com
APP_HOST              # https://clockinproof.com
```
