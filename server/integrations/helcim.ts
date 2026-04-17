/**
 * Helcim Payment Integration
 * FBC Home Concept LLC — Ops Center
 *
 * ⚠️  STUB — Helcim API key not yet configured.
 *    Search for "TODO(helcim)" to find all placeholder sections.
 *    Once you have your Helcim account and API token, set HELCIM_API_TOKEN
 *    in Replit Secrets and replace the stubs below.
 *
 * Helcim API docs: https://devdocs.helcim.com/
 *
 * Required env vars:
 *   HELCIM_API_TOKEN  — obtained from Helcim merchant portal → API Access
 */

import { Router, Request, Response } from "express";

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HELCIM_API_BASE = "https://api.helcim.com/v2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HelcimCardData {
  /** Card number (for card-not-present, PCI scope applies) */
  cardNumber?: string;
  cardExpiry?: string; // MMYY
  cardCVV?: string;
  cardHolderName?: string;
}

interface HelcimBillingAddress {
  name?: string;
  street1?: string;
  city?: string;
  province?: string;  // State abbreviation
  postalCode?: string;
  country?: string;   // 2-letter ISO, e.g. "US"
  phone?: string;
  email?: string;
}

interface HelcimPaymentRequest {
  /** Amount in dollars, e.g. 150.00 */
  amount: number;
  currency?: string; // default "USD"
  /** Your internal order ID / contract ID */
  invoiceNumber?: string;
  /** Description shown on receipt */
  ipAddress?: string;
  billingAddress?: HelcimBillingAddress;
  cardData?: HelcimCardData;
  /** Terminal ID for in-person payments */
  terminalId?: string;
  /** Customer code from Helcim customer profile */
  customerCode?: string;
  /** Card token from a prior transaction (for stored cards) */
  cardToken?: string;
}

interface HelcimWebhookPayload {
  eventId?: string;
  eventType?: string;
  transactionId?: string;
  status?: string;
  amount?: number;
  currency?: string;
  invoiceNumber?: string;
  customerCode?: string;
  approvalCode?: string;
  cardToken?: string;
  dateCreated?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if Helcim is configured.
 */
function isHelcimConfigured(): boolean {
  return !!process.env.HELCIM_API_TOKEN;
}

/**
 * Make an authenticated request to Helcim API.
 * TODO(helcim): Verify the exact auth header format in Helcim docs once you have API access.
 * Likely: api-token header or Bearer token — confirm at https://devdocs.helcim.com/
 */
async function helcimRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const apiToken = process.env.HELCIM_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "HELCIM_API_TOKEN is not set. Sign up at helcim.com, then add the token to Replit Secrets."
    );
  }

  const url = `${HELCIM_API_BASE}${path}`;

  console.log(`[Helcim] ${method} ${url}`);

  // TODO(helcim): Confirm exact auth header — check Helcim API docs
  // Common formats are:
  //   api-token: <token>
  //   Authorization: Bearer <token>
  // Using api-token header based on Helcim documentation pattern:
  const res = await fetch(url, {
    method,
    headers: {
      "api-token": apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Helcim API error (${res.status}) on ${method} ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GET /api/integrations/helcim/status
// ---------------------------------------------------------------------------
router.get("/status", async (_req: Request, res: Response) => {
  if (!isHelcimConfigured()) {
    return res.json({
      connected: false,
      stub: true,
      message: "HELCIM_API_TOKEN not set. Add it to Replit Secrets once you have a Helcim account.",
      signupUrl: "https://www.helcim.com/",
      docsUrl: "https://devdocs.helcim.com/",
    });
  }

  try {
    // TODO(helcim): Replace with the correct Helcim health-check or account endpoint
    // Example candidate endpoint — verify in Helcim docs:
    const data = await helcimRequest<{ merchantName?: string; merchantId?: string }>(
      "GET",
      "/connection-test"
    );

    return res.json({
      connected: true,
      merchantName: data?.merchantName ?? "Unknown",
      merchantId: data?.merchantId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Helcim] Status check failed:", message);
    return res.status(500).json({ connected: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/integrations/helcim/terminals
// ---------------------------------------------------------------------------
router.get("/terminals", async (_req: Request, res: Response) => {
  if (!isHelcimConfigured()) {
    return res.json({
      stub: true,
      terminals: [],
      message: "Helcim not yet configured. Set HELCIM_API_TOKEN in Replit Secrets.",
    });
  }

  try {
    // TODO(helcim): Verify terminal listing endpoint in Helcim docs
    // Candidate: GET /v2/terminals or GET /v2/payment-terminals
    const data = await helcimRequest<{ terminals?: unknown[] }>("GET", "/terminals");

    return res.json({
      success: true,
      terminals: data?.terminals ?? [],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Helcim] terminals error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/integrations/helcim/create-payment
// Body: HelcimPaymentRequest
// ---------------------------------------------------------------------------
router.post("/create-payment", async (req: Request, res: Response) => {
  const payload = req.body as HelcimPaymentRequest;

  // Validation
  if (!payload.amount || payload.amount <= 0) {
    return res.status(400).json({ error: "amount is required and must be > 0" });
  }

  if (!isHelcimConfigured()) {
    // Return a clear stub response instead of 500
    console.warn("[Helcim] create-payment called but HELCIM_API_TOKEN is not set (stub mode)");
    return res.status(503).json({
      stub: true,
      error: "Helcim integration is not yet configured.",
      message: "Set HELCIM_API_TOKEN in Replit Secrets to enable payments.",
      payloadReceived: {
        amount: payload.amount,
        currency: payload.currency ?? "USD",
        invoiceNumber: payload.invoiceNumber,
      },
    });
  }

  try {
    // TODO(helcim): Map FBC payload fields to Helcim's exact request schema.
    // Review https://devdocs.helcim.com/reference/payment-purchase for field names.
    // The structure below follows Helcim's documented card purchase format:
    const helcimBody: Record<string, unknown> = {
      ipAddress: payload.ipAddress ?? "127.0.0.1", // TODO(helcim): Pass real client IP via req.ip
      currency: payload.currency ?? "USD",
      amount: payload.amount,
      ...(payload.invoiceNumber && { invoiceNumber: payload.invoiceNumber }),
      ...(payload.terminalId && { terminalId: payload.terminalId }),
      ...(payload.customerCode && { customerCode: payload.customerCode }),
      ...(payload.cardToken && { cardToken: payload.cardToken }),
      ...(payload.cardData && {
        cardData: {
          cardNumber: payload.cardData.cardNumber,
          cardExpiry: payload.cardData.cardExpiry,
          cardCVV: payload.cardData.cardCVV,
          cardHolderName: payload.cardData.cardHolderName,
        },
      }),
      ...(payload.billingAddress && { billingAddress: payload.billingAddress }),
    };

    // TODO(helcim): Verify endpoint path — may be /helcim-pay or /purchase
    const result = await helcimRequest<{
      transactionId?: string;
      status?: string;
      approvalCode?: string;
      cardToken?: string;
    }>("POST", "/payment/purchase", helcimBody);

    console.log("[Helcim] Payment created. TxnId:", result?.transactionId);

    // TODO: Persist result to FBC payments table
    // db.insert('payments', { helcimTransactionId: result.transactionId, amount: payload.amount, ... })

    return res.json({
      success: true,
      transactionId: result?.transactionId,
      status: result?.status,
      approvalCode: result?.approvalCode,
      cardToken: result?.cardToken, // Store for future charges
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Helcim] create-payment error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/helcim/payment
// Handles Helcim payment webhook — auto-records payment in FBC system
// Configure webhook URL in Helcim Portal → Settings → Webhooks
// ---------------------------------------------------------------------------
router.post("/payment", async (req: Request, res: Response) => {
  try {
    const payload = req.body as HelcimWebhookPayload;

    console.log("[Helcim Webhook] Received payment event:", {
      eventId: payload.eventId,
      eventType: payload.eventType,
      transactionId: payload.transactionId,
      status: payload.status,
      amount: payload.amount,
      invoiceNumber: payload.invoiceNumber,
    });

    // TODO(helcim): Implement webhook signature verification once you have API access.
    // Helcim likely sends a signature header — validate it to prevent spoofing.
    // Example pattern:
    // const sig = req.headers['x-helcim-signature'] as string;
    // if (!verifyHelcimSignature(sig, JSON.stringify(req.body), process.env.HELCIM_WEBHOOK_SECRET)) {
    //   return res.status(401).json({ error: 'Invalid webhook signature' });
    // }

    if (!payload.transactionId) {
      console.warn("[Helcim Webhook] Missing transactionId in payload");
      return res.status(400).json({ error: "Missing transactionId" });
    }

    // Only process successful payment events
    const successStatuses = ["APPROVED", "approved", "1"];
    if (!successStatuses.includes(payload.status ?? "")) {
      console.log(`[Helcim Webhook] Ignoring non-approved event: ${payload.status}`);
      return res.json({ received: true, processed: false, reason: "non-approved status" });
    }

    // TODO(helcim): Auto-record payment in FBC database
    // This links the Helcim transaction to a FBC payment record.
    // Example:
    // const existingPayment = await db.query(
    //   'SELECT id FROM payments WHERE helcim_transaction_id = $1',
    //   [payload.transactionId]
    // );
    // if (!existingPayment.rows.length) {
    //   await db.query(
    //     `INSERT INTO payments (amount, payment_method, helcim_transaction_id, reference, status, created_at)
    //      VALUES ($1, 'card', $2, $3, 'completed', NOW())`,
    //     [payload.amount, payload.transactionId, payload.invoiceNumber]
    //   );
    //   console.log('[Helcim Webhook] Payment recorded in FBC:', payload.transactionId);
    // } else {
    //   console.log('[Helcim Webhook] Duplicate event, skipping:', payload.transactionId);
    // }

    return res.json({ received: true, processed: true, transactionId: payload.transactionId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Helcim Webhook] Error:", message);
    return res.status(500).json({ error: message });
  }
});

export default router;
