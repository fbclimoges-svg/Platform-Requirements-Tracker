# FBC Ops Center — Integration Setup Instructions

Paste these instructions into **Replit Agent** to wire up the QuickBooks, Twilio, and Helcim integrations.

---

## Overview of files added

| File | Purpose |
|---|---|
| `server/integrations/quickbooks.ts` | QBO OAuth + customer/invoice/payment sync |
| `server/integrations/twilio.ts` | SMS send, reminders, inbound webhooks |
| `server/integrations/helcim.ts` | Payment processing (stubbed until API key available) |
| `server/integrations/index.ts` | Master router — mounts all three + `/api/integrations/status` |
| `server/notifications-fix.ts` | Fixes the broken `/api/notifications` 500 error |

---

## Step 1 — Install npm packages

Open the Replit **Shell** tab and run:

```bash
npm install twilio
```

> `node-fetch` is **not needed** — the app runs Node 18+ which has native `fetch`.
> The `twilio` npm package is only used if you want to use the official SDK. The integration files use native fetch directly, so the package install is optional unless you switch to the SDK.

---

## Step 2 — Add the integration files

Paste each file into Replit at the exact paths shown:

1. Create `server/integrations/` folder if it doesn't exist
2. Add: `server/integrations/quickbooks.ts`
3. Add: `server/integrations/twilio.ts`
4. Add: `server/integrations/helcim.ts`
5. Add: `server/integrations/index.ts`
6. Add: `server/notifications-fix.ts`

---

## Step 3 — Wire up routes in your main server file

Open `server/routes.ts` (or `server/index.ts`, wherever your Express routes are registered) and add:

```typescript
// At the top — add these imports
import integrationsRouter from './integrations/index';
import { notificationsRouter } from './notifications-fix';

// In your route registration block — add these lines
app.use('/api', integrationsRouter);
app.use('/api', notificationsRouter);
```

**Important:** Place these **before** any catch-all 404 handler you may have.

### If you have an existing notifications route returning 500

Find and **remove or comment out** the old broken notifications route, then the new one from `notifications-fix.ts` will take over.

---

## Step 4 — Set environment variables in Replit Secrets

Go to **Tools → Secrets** in Replit and add each key below.

### QuickBooks Online (QBO)

| Secret Key | Value |
|---|---|
| `QBO_CLIENT_ID` | From Intuit Developer → your app's OAuth2 Client ID |
| `QBO_CLIENT_SECRET` | From Intuit Developer → your app's OAuth2 Client Secret |
| `QBO_REFRESH_TOKEN` | Long-lived refresh token from Pipedream OAuth connector |
| `QBO_REALM_ID` | Your QBO Company ID (from Settings → Account and Settings) |
| `QBO_SANDBOX` | `true` for sandbox, omit or set `false` for production |

**How to get the refresh token from Pipedream:**
1. Open the Pipedream project connected to your QBO app
2. Go to Connected Accounts → QuickBooks → View Token
3. Copy the `refresh_token` value

### Twilio

| Secret Key | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | From Twilio Console → Account SID |
| `TWILIO_AUTH_TOKEN` | From Twilio Console → Auth Token |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number in E.164 format (e.g. `+1XXXXXXXXXX`) |
| `TWILIO_MESSAGING_SERVICE_SID` | From Twilio Console → Messaging → Services |

### Helcim (set once you have an account)

| Secret Key | Value |
|---|---|
| `HELCIM_API_TOKEN` | From Helcim Portal → Settings → API Access |

> Until `HELCIM_API_TOKEN` is set, all Helcim routes return a clear stub response instead of crashing.

---

## Step 5 — Configure Twilio Webhooks

In the **Twilio Console** (console.twilio.com):

1. Go to **Phone Numbers → Manage → Active Numbers → (your Twilio number)**
2. Under **Messaging**, set:
   - **A message comes in** → `https://YOUR-REPLIT-URL.replit.dev/api/webhooks/twilio/incoming`
   - **Primary handler fails** → leave blank
   - **Message Status Changes** → `https://YOUR-REPLIT-URL.replit.dev/api/webhooks/twilio/status`
3. Click **Save**

> Replace `YOUR-REPLIT-URL` with your actual Replit app URL from the webview tab.

---

## Step 6 — Configure Helcim Webhooks (when ready)

In the **Helcim Portal** → Settings → Webhooks, add:

- **Event:** Payment Approved
- **URL:** `https://YOUR-REPLIT-URL.replit.dev/api/webhooks/helcim/payment`

---

## Step 7 — Create the notifications table (if needed)

If your database doesn't have a `notifications` table yet, run this SQL in your database console:

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'info',
  entity_type  TEXT,
  entity_id    INTEGER,
  is_read      BOOLEAN NOT NULL DEFAULT false,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id    ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read    ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
```

The SQL is also exported from `server/notifications-fix.ts` as `CREATE_NOTIFICATIONS_TABLE_SQL`.

### Attach the db instance

The notifications fix looks for `app.locals.db`. Make sure your server file does:

```typescript
app.locals.db = pool; // or your db/drizzle instance
```

---

## Step 8 — Test each integration

### QuickBooks

```bash
# Check connection status
curl https://YOUR-REPLIT-URL.replit.dev/api/integrations/quickbooks/status

# Sync a customer
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/integrations/quickbooks/sync-customer \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Jane Smith","email":"jane@example.com","phone":"+15555551234"}'

# Create an invoice (use a real QBO customer ID from the sync response)
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/integrations/quickbooks/create-invoice \
  -H "Content-Type: application/json" \
  -d '{
    "qboCustomerId": "123",
    "lineItems": [{"description":"Countertop installation","amount":2500}],
    "dueDate":"2025-02-28"
  }'

# Record a payment
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/integrations/quickbooks/sync-payment \
  -H "Content-Type: application/json" \
  -d '{"qboCustomerId":"123","amount":1250,"qboInvoiceId":"456"}'
```

### Twilio

```bash
# Check connection
curl https://YOUR-REPLIT-URL.replit.dev/api/integrations/twilio/status

# Send a test SMS (use your own phone number)
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/integrations/twilio/send-sms \
  -H "Content-Type: application/json" \
  -d '{"to":"+15555550000","message":"Test from FBC Ops Center"}'

# Send an appointment reminder
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/integrations/twilio/send-reminder \
  -H "Content-Type: application/json" \
  -d '{
    "to":"+15555550000",
    "reminderType":"appointment",
    "customerName":"Jane",
    "date":"Tuesday Jan 28 at 10am"
  }'

# Send a payment reminder
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/integrations/twilio/send-reminder \
  -H "Content-Type: application/json" \
  -d '{
    "to":"+15555550000",
    "reminderType":"payment",
    "customerName":"Jane",
    "amount":1250.00,
    "date":"January 31"
  }'
```

### Helcim (stub — works before API key is set)

```bash
# Check connection status (will show stub info)
curl https://YOUR-REPLIT-URL.replit.dev/api/integrations/helcim/status

# Try creating a payment (returns 503 stub response until key is set)
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/integrations/helcim/create-payment \
  -H "Content-Type: application/json" \
  -d '{"amount":500.00,"invoiceNumber":"FBC-001"}'
```

### Notifications

```bash
# Should no longer return 500
curl https://YOUR-REPLIT-URL.replit.dev/api/notifications

# Stats (unread count)
curl https://YOUR-REPLIT-URL.replit.dev/api/notifications/stats

# Create a test notification
curl -X POST https://YOUR-REPLIT-URL.replit.dev/api/notifications \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Alert","message":"This is a test notification","type":"info"}'
```

### All integrations at once

```bash
curl https://YOUR-REPLIT-URL.replit.dev/api/integrations/status
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| QBO returns 401 | Refresh token is expired or invalid. Re-connect via Pipedream and update `QBO_REFRESH_TOKEN` |
| QBO returns "duplicate name" | Customer with that `DisplayName` already exists — the sync route handles this with upsert logic |
| Twilio returns 21608 | The number isn't SMS-capable or the Messaging Service SID is wrong |
| Twilio returns 20003 | Wrong Auth Token — re-check `TWILIO_AUTH_TOKEN` in Secrets |
| Notifications still 500 | Make sure `app.locals.db = pool` is set before route registration |
| Notifications table missing | Run the CREATE TABLE SQL from Step 7 |
| Helcim 404 on `/connection-test` | This endpoint is a placeholder — check Helcim docs for the correct health check URL and update `helcim.ts` |

---

## New API Endpoints Added

| Method | Path | Description |
|---|---|---|
| GET | `/api/integrations/status` | All integrations status |
| GET | `/api/integrations/quickbooks/status` | QBO connection check |
| POST | `/api/integrations/quickbooks/sync-customer` | Sync customer to QBO |
| POST | `/api/integrations/quickbooks/create-invoice` | Create QBO invoice |
| POST | `/api/integrations/quickbooks/sync-payment` | Record payment in QBO |
| GET | `/api/integrations/twilio/status` | Twilio connection check |
| POST | `/api/integrations/twilio/send-sms` | Send SMS |
| POST | `/api/integrations/twilio/send-reminder` | Send templated reminder |
| POST | `/api/webhooks/twilio/incoming` | Inbound SMS webhook (TwiML) |
| POST | `/api/webhooks/twilio/status` | Message status callback |
| GET | `/api/integrations/helcim/status` | Helcim connection check |
| GET | `/api/integrations/helcim/terminals` | List payment terminals |
| POST | `/api/integrations/helcim/create-payment` | Initiate card payment |
| POST | `/api/webhooks/helcim/payment` | Helcim payment webhook |
| GET | `/api/notifications` | List notifications |
| GET | `/api/notifications/stats` | Unread count |
| POST | `/api/notifications` | Create notification |
| PATCH | `/api/notifications/:id/read` | Mark one as read |
| PATCH | `/api/notifications/read-all` | Mark all as read |
