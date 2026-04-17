/**
 * Twilio Integration
 * FBC Home Concept LLC — Ops Center
 *
 * Handles outbound SMS, reminders, and inbound webhook processing.
 * Required env vars:
 *   TWILIO_ACCOUNT_SID           — from Twilio Console
 *   TWILIO_AUTH_TOKEN            — from Twilio Console
 *   TWILIO_PHONE_NUMBER          — your Twilio phone number (E.164 format)
 *   TWILIO_MESSAGING_SERVICE_SID — from Twilio Messaging Services (optional, preferred)
 */

import { Router, Request, Response } from "express";

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TwilioMessageRequest {
  Body: string;
  /** Destination phone number, e.g. "+15555551234" */
  To: string;
  /** Override sender. Defaults to Messaging Service SID if set, else phone number. */
  From?: string;
  MessagingServiceSid?: string;
  StatusCallback?: string;
}

interface TwilioMessageResponse {
  sid: string;
  status: string;
  to: string;
  from: string;
  body: string;
  errorCode: number | null;
  errorMessage: string | null;
  dateCreated: string;
}

type ReminderType = "appointment" | "payment" | "estimate" | "custom";

interface ReminderPayload {
  to: string;
  reminderType: ReminderType;
  customerName?: string;
  /** ISO date string or human-readable date */
  date?: string;
  /** Dollar amount for payment reminders */
  amount?: number;
  /** Custom message override (used when reminderType === "custom") */
  message?: string;
  jobId?: string | number;
  estimateId?: string | number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build Twilio Basic Auth header from env credentials.
 */
function twilioAuth(): string {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error(
      "Missing Twilio credentials. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Replit Secrets."
    );
  }
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

/**
 * Send a message via Twilio Messages API.
 */
async function sendTwilioMessage(params: {
  to: string;
  body: string;
  statusCallbackUrl?: string;
}): Promise<TwilioMessageResponse> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!accountSid) {
    throw new Error("TWILIO_ACCOUNT_SID is not set");
  }

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  const form = new URLSearchParams({
    To: params.to,
    Body: params.body,
  });

  // Prefer Messaging Service SID (enables best practices + delivery optimization)
  if (messagingServiceSid) {
    form.set("MessagingServiceSid", messagingServiceSid);
  } else if (fromNumber) {
    form.set("From", fromNumber);
  } else {
    throw new Error(
      "Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER in Replit Secrets."
    );
  }

  if (params.statusCallbackUrl) {
    form.set("StatusCallback", params.statusCallbackUrl);
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  console.log(`[Twilio] Sending SMS to ${params.to}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: twilioAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  const data = await res.json() as TwilioMessageResponse & { message?: string; code?: number };

  if (!res.ok) {
    throw new Error(
      `Twilio API error (${res.status}): ${data.message ?? "Unknown error"} (code: ${data.code ?? "N/A"})`
    );
  }

  console.log(`[Twilio] Message sent. SID: ${data.sid}, Status: ${data.status}`);
  return data as TwilioMessageResponse;
}

/**
 * Build reminder message text based on reminder type.
 */
function buildReminderMessage(payload: ReminderPayload): string {
  const name = payload.customerName ? `, ${payload.customerName}` : "";

  switch (payload.reminderType) {
    case "appointment":
      return (
        `Hi${name}! This is FBC Home Concept (Countertops & More). ` +
        `Your appointment is scheduled for ${payload.date ?? "soon"}. ` +
        `Reply STOP to opt out.`
      );

    case "payment":
      return (
        `Hi${name}! FBC Home Concept reminder: ` +
        `A payment of $${payload.amount?.toFixed(2) ?? "N/A"} is due ${payload.date ?? "soon"}. ` +
        `Questions? Call us. Reply STOP to opt out.`
      );

    case "estimate":
      return (
        `Hi${name}! Your estimate from FBC Home Concept is ready for review. ` +
        `${payload.date ? `Please respond by ${payload.date}.` : ""} ` +
        `Reply STOP to opt out.`
      );

    case "custom":
      if (!payload.message) {
        throw new Error("message is required when reminderType is 'custom'");
      }
      return payload.message;

    default:
      throw new Error(`Unknown reminderType: ${payload.reminderType}`);
  }
}

/**
 * Validate a US/international phone number format.
 */
function validatePhone(phone: string): boolean {
  return /^\+?[1-9]\d{7,14}$/.test(phone.replace(/[\s\-().]/g, ""));
}

// ---------------------------------------------------------------------------
// GET /api/integrations/twilio/status
// ---------------------------------------------------------------------------
router.get("/status", async (_req: Request, res: Response) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const hasConfig = !!(accountSid && process.env.TWILIO_AUTH_TOKEN);

    if (!hasConfig) {
      return res.json({
        connected: false,
        error: "Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN",
      });
    }

    // Verify by fetching account info
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`;
    const accountRes = await fetch(url, {
      headers: { Authorization: twilioAuth() },
    });

    if (!accountRes.ok) {
      const text = await accountRes.text();
      return res.json({ connected: false, error: `Twilio returned ${accountRes.status}: ${text}` });
    }

    const account = await accountRes.json() as { friendly_name: string; status: string };

    return res.json({
      connected: true,
      accountSid,
      accountName: account.friendly_name,
      accountStatus: account.status,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Twilio] Status check failed:", message);
    return res.status(500).json({ connected: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/integrations/twilio/send-sms
// Body: { to, message }
// ---------------------------------------------------------------------------
router.post("/send-sms", async (req: Request, res: Response) => {
  try {
    const { to, message } = req.body as { to?: string; message?: string };

    if (!to || !message) {
      return res.status(400).json({ error: "to and message are required" });
    }

    if (!validatePhone(to)) {
      return res.status(400).json({ error: "Invalid phone number format. Use E.164, e.g. +15555551234" });
    }

    if (message.length > 1600) {
      return res.status(400).json({ error: "Message exceeds 1600 character limit" });
    }

    const result = await sendTwilioMessage({ to, body: message });

    return res.json({
      success: true,
      messageSid: result.sid,
      status: result.status,
      to: result.to,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Twilio] send-sms error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/integrations/twilio/send-reminder
// Body: ReminderPayload
// ---------------------------------------------------------------------------
router.post("/send-reminder", async (req: Request, res: Response) => {
  try {
    const payload = req.body as ReminderPayload;

    if (!payload.to) {
      return res.status(400).json({ error: "to is required" });
    }

    if (!payload.reminderType) {
      return res.status(400).json({
        error: "reminderType is required. Valid: appointment | payment | estimate | custom",
      });
    }

    if (!validatePhone(payload.to)) {
      return res.status(400).json({ error: "Invalid phone number format. Use E.164, e.g. +15555551234" });
    }

    const messageBody = buildReminderMessage(payload);

    const result = await sendTwilioMessage({ to: payload.to, body: messageBody });

    console.log(
      `[Twilio] Reminder (${payload.reminderType}) sent to ${payload.to}. SID: ${result.sid}`
    );

    return res.json({
      success: true,
      reminderType: payload.reminderType,
      messageSid: result.sid,
      status: result.status,
      to: result.to,
      messagePreview: messageBody.substring(0, 80) + (messageBody.length > 80 ? "..." : ""),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Twilio] send-reminder error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/twilio/incoming
// Handles inbound SMS from Twilio (webhook URL configured in Twilio Console)
// Returns TwiML XML
// ---------------------------------------------------------------------------
router.post("/incoming", (req: Request, res: Response) => {
  const from = req.body?.From as string | undefined;
  const body = req.body?.Body as string | undefined;
  const messageSid = req.body?.MessageSid as string | undefined;

  console.log(`[Twilio Webhook] Incoming SMS from ${from ?? "unknown"}: "${body ?? ""}" (SID: ${messageSid ?? "N/A"})`);

  // TODO: Persist inbound message to database
  // Example: db.insert('sms_log', { from, body, messageSid, direction: 'inbound', createdAt: new Date() })

  // Auto-handle opt-out keywords (Twilio handles STOP/HELP natively, but log them)
  const normalizedBody = (body ?? "").trim().toUpperCase();
  let replyMessage = "Thank you for contacting FBC Home Concept. We'll be in touch shortly!";

  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(normalizedBody)) {
    replyMessage = "You have been unsubscribed. Reply START to resubscribe.";
  } else if (["START", "UNSTOP", "YES"].includes(normalizedBody)) {
    replyMessage = "Welcome back! You are now subscribed to FBC Home Concept messages.";
  } else if (["HELP", "INFO"].includes(normalizedBody)) {
    replyMessage =
      "FBC Home Concept — Countertops & More. Call us at your project number for assistance. Reply STOP to opt out.";
  }

  // Return TwiML response
  res.set("Content-Type", "text/xml");
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(replyMessage)}</Message>
</Response>`);
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/twilio/status
// Handles message status callbacks (delivered, failed, etc.)
// ---------------------------------------------------------------------------
router.post("/status", (req: Request, res: Response) => {
  const messageSid = req.body?.MessageSid as string | undefined;
  const messageStatus = req.body?.MessageStatus as string | undefined;
  const to = req.body?.To as string | undefined;
  const errorCode = req.body?.ErrorCode as string | undefined;

  console.log(
    `[Twilio Status] SID: ${messageSid ?? "N/A"}, Status: ${messageStatus ?? "N/A"}, To: ${to ?? "N/A"}` +
      (errorCode ? `, ErrorCode: ${errorCode}` : "")
  );

  // TODO: Update message status in your database
  // Example:
  // if (messageSid) {
  //   db.update('sms_log', { status: messageStatus, errorCode }, { where: { messageSid } });
  // }

  // Log failed messages for follow-up
  if (messageStatus === "failed" || messageStatus === "undelivered") {
    console.warn(
      `[Twilio Status] ⚠️  Message ${messageSid} ${messageStatus} to ${to}. Error code: ${errorCode ?? "none"}`
    );
    // TODO: Trigger alert or retry logic here
  }

  // Twilio expects a 204 or 200 with empty body for status callbacks
  return res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Utility: XML escape
// ---------------------------------------------------------------------------
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export default router;
