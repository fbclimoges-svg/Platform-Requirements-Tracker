/**
 * Integrations Router — Master Mount Point
 * FBC Home Concept LLC — Ops Center
 *
 * Mounts all third-party integration sub-routers and exposes a
 * unified /api/integrations/status endpoint.
 *
 * Wire this into your main server file:
 *
 *   import integrationsRouter from './integrations/index';
 *   app.use('/api', integrationsRouter);
 *   // This exposes:
 *   //   /api/integrations/*         (all integration routes)
 *   //   /api/webhooks/twilio/*      (Twilio webhook routes)
 *   //   /api/webhooks/helcim/*      (Helcim webhook routes)
 */

import { Router, Request, Response } from "express";
import quickbooksRouter from "./quickbooks";
import twilioRouter from "./twilio";
import helcimRouter from "./helcim";

const router = Router();

// ---------------------------------------------------------------------------
// Mount sub-routers
// ---------------------------------------------------------------------------

// QBO routes: /api/integrations/quickbooks/*
router.use("/integrations/quickbooks", quickbooksRouter);

// Twilio integration routes: /api/integrations/twilio/*
// Twilio webhook routes: /api/webhooks/twilio/*
router.use("/integrations/twilio", twilioRouter);
router.use("/webhooks/twilio", twilioRouter);

// Helcim integration routes: /api/integrations/helcim/*
// Helcim webhook routes: /api/webhooks/helcim/*
router.use("/integrations/helcim", helcimRouter);
router.use("/webhooks/helcim", helcimRouter);

// ---------------------------------------------------------------------------
// GET /api/integrations/status — Aggregate status of all integrations
// ---------------------------------------------------------------------------
router.get("/integrations/status", async (_req: Request, res: Response) => {
  const results: Record<string, unknown> = {};
  const startTime = Date.now();

  // Run all status checks concurrently
  const [qboResult, twilioResult, helcimResult] = await Promise.allSettled([
    checkQBOStatus(),
    checkTwilioStatus(),
    checkHelcimStatus(),
  ]);

  results.quickbooks = qboResult.status === "fulfilled"
    ? qboResult.value
    : { connected: false, error: String((qboResult as PromiseRejectedResult).reason) };

  results.twilio = twilioResult.status === "fulfilled"
    ? twilioResult.value
    : { connected: false, error: String((twilioResult as PromiseRejectedResult).reason) };

  results.helcim = helcimResult.status === "fulfilled"
    ? helcimResult.value
    : { connected: false, error: String((helcimResult as PromiseRejectedResult).reason) };

  const allConnected = Object.values(results).every(
    (r) => (r as { connected?: boolean }).connected === true
  );

  return res.json({
    allConnected,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    integrations: results,
  });
});

// ---------------------------------------------------------------------------
// Internal status helpers (lightweight — avoid full API roundtrip)
// ---------------------------------------------------------------------------

async function checkQBOStatus(): Promise<{ connected: boolean; [key: string]: unknown }> {
  const proxyUrl = process.env.QBO_PROXY_URL;
  const proxyKey = process.env.QBO_PROXY_KEY;

  if (!proxyUrl || !proxyKey) {
    return {
      connected: false,
      error: "Missing QBO_PROXY_URL or QBO_PROXY_KEY",
    };
  }

  // Return config-present indicator without making a live API call
  // (full verification available at /api/integrations/quickbooks/status)
  return {
    connected: true,
    realmId: process.env.QBO_REALM_ID ?? "320590895",
    mode: "proxy",
    note: "Proxy configured. Call /api/integrations/quickbooks/status for live verification.",
  };
}

async function checkTwilioStatus(): Promise<{ connected: boolean; [key: string]: unknown }> {
  const hasConfig = !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN
  );

  if (!hasConfig) {
    return {
      connected: false,
      error: "Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN",
    };
  }

  return {
    connected: true,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    note: "Credentials present. Call /api/integrations/twilio/status for live verification.",
  };
}

async function checkHelcimStatus(): Promise<{ connected: boolean; [key: string]: unknown }> {
  const hasConfig = !!process.env.HELCIM_API_TOKEN;

  if (!hasConfig) {
    return {
      connected: false,
      stub: true,
      message: "HELCIM_API_TOKEN not set. Integration is stubbed until Helcim account is created.",
    };
  }

  return {
    connected: true,
    note: "Credentials present. Call /api/integrations/helcim/status for live verification.",
  };
}

export default router;
