/**
 * QuickBooks Online Integration
 * FBC Home Concept LLC — Ops Center
 *
 * Handles OAuth token refresh and QBO API v3 calls.
 * Required env vars:
 *   QBO_CLIENT_ID        — OAuth2 client ID
 *   QBO_CLIENT_SECRET    — OAuth2 client secret
 *   QBO_REFRESH_TOKEN    — long-lived refresh token (write back on refresh)
 *   QBO_REALM_ID         — Company ID from QBO Settings
 *   QBO_SANDBOX          — set to "true" for sandbox environment (optional)
 */

import { Router, Request, Response } from "express";

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QBO_BASE = process.env.QBO_SANDBOX === "true"
  ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
  : "https://quickbooks.api.intuit.com/v3/company";

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_DISCOVERY_URL = "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration";

// In-memory token cache (survives hot-reloads in dev, adequate for single-instance)
let cachedAccessToken: string | null = null;
let tokenExpiresAt: number = 0; // Unix ms

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface QBOCustomer {
  DisplayName: string;
  PrimaryPhone?: { FreeFormNumber: string };
  PrimaryEmailAddr?: { Address: string };
  BillAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
  };
  CompanyName?: string;
}

interface QBOInvoiceLine {
  Amount: number;
  DetailType: "SalesItemLineDetail";
  SalesItemLineDetail: {
    ItemRef: { value: string; name: string };
    Qty?: number;
    UnitPrice?: number;
  };
  Description?: string;
}

interface QBOInvoice {
  CustomerRef: { value: string };
  Line: QBOInvoiceLine[];
  DueDate?: string;
  DocNumber?: string;
  PrivateNote?: string;
}

interface QBOPayment {
  CustomerRef: { value: string };
  TotalAmt: number;
  PaymentMethodRef?: { value: string };
  DepositToAccountRef?: { value: string };
  Line?: Array<{
    Amount: number;
    LinkedTxn: Array<{ TxnId: string; TxnType: "Invoice" }>;
  }>;
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/**
 * Returns a valid access token, refreshing if necessary.
 */
async function getAccessToken(): Promise<string> {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (cachedAccessToken && now < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const refreshToken = process.env.QBO_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing QBO credentials. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN in Replit Secrets."
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  console.log("[QBO] Refreshing access token...");

  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  cachedAccessToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;

  // If QBO rotated the refresh token, log it so the operator can update the secret
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn(
      "[QBO] ⚠️  Refresh token rotated. Update QBO_REFRESH_TOKEN secret with:",
      data.refresh_token
    );
  }

  console.log("[QBO] Access token refreshed. Expires in", data.expires_in, "s");
  return cachedAccessToken!;
}

/**
 * Generic authenticated QBO API request.
 */
async function qboRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken();
  const realmId = process.env.QBO_REALM_ID;
  const url = `${QBO_BASE}/${realmId}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  console.log(`[QBO] ${method} ${url}`);

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO API error (${res.status}) on ${method} ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GET /api/integrations/quickbooks/status
// ---------------------------------------------------------------------------
router.get("/status", async (_req: Request, res: Response) => {
  try {
    const realmId = process.env.QBO_REALM_ID;
    const hasConfig = !!(
      process.env.QBO_CLIENT_ID &&
      process.env.QBO_CLIENT_SECRET &&
      process.env.QBO_REFRESH_TOKEN
    );

    if (!hasConfig) {
      return res.json({
        connected: false,
        realmId,
        error: "Missing QBO environment variables",
      });
    }

    // Attempt a lightweight API call to verify credentials
    const data = await qboRequest<{ CompanyInfo: { CompanyName: string } }>(
      "GET",
      `/companyinfo/${realmId}`
    );

    return res.json({
      connected: true,
      realmId,
      companyName: data?.CompanyInfo?.CompanyName ?? "Unknown",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[QBO] Status check failed:", message);
    return res.status(500).json({ connected: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/integrations/quickbooks/sync-customer
// Body: { customerId, displayName, email?, phone?, address?, company? }
// ---------------------------------------------------------------------------
router.post("/sync-customer", async (req: Request, res: Response) => {
  try {
    const { customerId, displayName, email, phone, address, company } = req.body as {
      customerId?: string | number;
      displayName: string;
      email?: string;
      phone?: string;
      address?: { line1?: string; city?: string; state?: string; zip?: string };
      company?: string;
    };

    if (!displayName) {
      return res.status(400).json({ error: "displayName is required" });
    }

    const customer: QBOCustomer = {
      DisplayName: displayName,
      ...(company && { CompanyName: company }),
      ...(phone && { PrimaryPhone: { FreeFormNumber: phone } }),
      ...(email && { PrimaryEmailAddr: { Address: email } }),
      ...(address && {
        BillAddr: {
          Line1: address.line1,
          City: address.city,
          CountrySubDivisionCode: address.state,
          PostalCode: address.zip,
        },
      }),
    };

    // Search for existing QBO customer by DisplayName first
    const searchQuery = encodeURIComponent(
      `SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}'`
    );
    const searchResult = await qboRequest<{
      QueryResponse: { Customer?: Array<{ Id: string; DisplayName: string }> };
    }>("GET", `/query?query=${searchQuery}`);

    const existing = searchResult?.QueryResponse?.Customer?.[0];

    let result: unknown;
    if (existing) {
      // Update existing customer
      console.log(`[QBO] Updating existing customer ID ${existing.Id}`);
      result = await qboRequest("POST", "/customer", {
        ...customer,
        Id: existing.Id,
        sparse: true,
      });
    } else {
      // Create new customer
      console.log("[QBO] Creating new customer:", displayName);
      result = await qboRequest("POST", "/customer", customer);
    }

    return res.json({
      success: true,
      action: existing ? "updated" : "created",
      fbcCustomerId: customerId,
      qboResult: result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[QBO] sync-customer error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/integrations/quickbooks/create-invoice
// Body: { contractId, qboCustomerId, lineItems, dueDate?, docNumber? }
// lineItems: Array<{ description, amount, qty?, itemRef? }>
// ---------------------------------------------------------------------------
router.post("/create-invoice", async (req: Request, res: Response) => {
  try {
    const { contractId, qboCustomerId, lineItems, dueDate, docNumber, privateNote } =
      req.body as {
        contractId?: string | number;
        qboCustomerId: string;
        lineItems: Array<{
          description?: string;
          amount: number;
          qty?: number;
          unitPrice?: number;
          itemRef?: string; // QBO item ID, defaults to "1" (Services)
        }>;
        dueDate?: string;
        docNumber?: string;
        privateNote?: string;
      };

    if (!qboCustomerId || !lineItems?.length) {
      return res.status(400).json({ error: "qboCustomerId and lineItems are required" });
    }

    const lines: QBOInvoiceLine[] = lineItems.map((item) => ({
      Amount: item.amount,
      DetailType: "SalesItemLineDetail",
      Description: item.description,
      SalesItemLineDetail: {
        ItemRef: { value: item.itemRef ?? "1", name: "Services" },
        Qty: item.qty ?? 1,
        UnitPrice: item.unitPrice ?? item.amount,
      },
    }));

    const invoice: QBOInvoice = {
      CustomerRef: { value: qboCustomerId },
      Line: lines,
      ...(dueDate && { DueDate: dueDate }),
      ...(docNumber && { DocNumber: docNumber }),
      ...(privateNote && { PrivateNote: privateNote }),
    };

    const result = await qboRequest<{ Invoice: { Id: string; DocNumber: string } }>(
      "POST",
      "/invoice",
      invoice
    );

    console.log("[QBO] Invoice created:", result?.Invoice?.Id);

    return res.json({
      success: true,
      fbcContractId: contractId,
      qboInvoiceId: result?.Invoice?.Id,
      qboDocNumber: result?.Invoice?.DocNumber,
      qboResult: result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[QBO] create-invoice error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/integrations/quickbooks/sync-payment
// Body: { qboCustomerId, amount, qboInvoiceId?, paymentMethod? }
// ---------------------------------------------------------------------------
router.post("/sync-payment", async (req: Request, res: Response) => {
  try {
    const { qboCustomerId, amount, qboInvoiceId, paymentMethodRef, depositAccountRef, fbcPaymentId } =
      req.body as {
        qboCustomerId: string;
        amount: number;
        qboInvoiceId?: string;
        paymentMethodRef?: string; // QBO PaymentMethod ID
        depositAccountRef?: string; // QBO Account ID for deposit
        fbcPaymentId?: string | number;
      };

    if (!qboCustomerId || !amount) {
      return res.status(400).json({ error: "qboCustomerId and amount are required" });
    }

    const payment: QBOPayment = {
      CustomerRef: { value: qboCustomerId },
      TotalAmt: amount,
      ...(paymentMethodRef && { PaymentMethodRef: { value: paymentMethodRef } }),
      ...(depositAccountRef && { DepositToAccountRef: { value: depositAccountRef } }),
      ...(qboInvoiceId && {
        Line: [
          {
            Amount: amount,
            LinkedTxn: [{ TxnId: qboInvoiceId, TxnType: "Invoice" }],
          },
        ],
      }),
    };

    const result = await qboRequest<{ Payment: { Id: string } }>(
      "POST",
      "/payment",
      payment
    );

    console.log("[QBO] Payment recorded:", result?.Payment?.Id);

    return res.json({
      success: true,
      fbcPaymentId,
      qboPaymentId: result?.Payment?.Id,
      qboResult: result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[QBO] sync-payment error:", message);
    return res.status(500).json({ error: message });
  }
});

export default router;
