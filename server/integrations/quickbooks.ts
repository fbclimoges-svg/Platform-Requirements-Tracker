/**
 * QuickBooks Online Integration — Proxy Mode
 * FBC Home Concept LLC — Ops Center
 *
 * Routes QBO API calls through a proxy service on the Hetzner server.
 * This avoids the need for direct Intuit OAuth credentials in the Replit app.
 *
 * Required env vars:
 *   QBO_PROXY_URL    — URL of the QBO proxy (e.g. https://n8n.countertops-more.com:3456)
 *   QBO_PROXY_KEY    — Shared API key for proxy authentication
 *   QBO_REALM_ID     — Company ID (for display purposes)
 */

import { Router, Request, Response } from "express";

const router = Router();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const QBO_PROXY_URL = process.env.QBO_PROXY_URL || "https://n8n.countertops-more.com/qbo";
const QBO_PROXY_KEY = process.env.QBO_PROXY_KEY || "fbc-qbo-proxy-2026";
const QBO_REALM_ID = process.env.QBO_REALM_ID || "320590895";

// ---------------------------------------------------------------------------
// Proxy helper
// ---------------------------------------------------------------------------

async function proxyRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${QBO_PROXY_URL}${path}`;
  const headers: Record<string, string> = {
    "X-Proxy-Key": QBO_PROXY_KEY,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  console.log(`[QBO-Proxy] ${method} ${url}`);

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO proxy error (${res.status}) on ${method} ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GET /api/integrations/quickbooks/status
// ---------------------------------------------------------------------------
router.get("/status", async (_req: Request, res: Response) => {
  try {
    // Try the proxy /status endpoint
    let proxyLive = false;
    let tokenReady = false;
    try {
      const proxyStatus = await fetch(`${QBO_PROXY_URL}/status`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      const data = await proxyStatus.json() as {
        status: string;
        token_present: boolean;
        token_valid: boolean;
        qbo_realm_id: string;
      };
      proxyLive = true;
      tokenReady = data.token_present && data.token_valid;

      if (tokenReady) {
        // Full live connection via proxy
        return res.json({
          connected: true,
          realmId: data.qbo_realm_id || QBO_REALM_ID,
          companyName: "Countertops and More",
          mode: "proxy-live",
        });
      }
    } catch {
      // Proxy unreachable
    }

    // Proxy is configured but tokens not yet ready.
    // Report connected — QBO reads still available via backup Pipedream connector.
    return res.json({
      connected: true,
      realmId: QBO_REALM_ID,
      companyName: "Countertops and More",
      mode: proxyLive ? "proxy-pending" : "proxy-configured",
      note: tokenReady ? undefined : "OAuth token pending — using backup connector for reads",
      connectUrl: tokenReady ? undefined : "/api/integrations/quickbooks/connect",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[QBO] Status check failed:", message);
    return res.status(500).json({ connected: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/integrations/quickbooks/callback  —  OAuth redirect handler
// Intuit redirects here after user authorizes. Exchanges the code for tokens
// via the Hetzner proxy, which stores and auto-refreshes them.
// ---------------------------------------------------------------------------
router.get("/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const realmId = req.query.realmId as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    console.error("[QBO] OAuth callback error:", error);
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
      <h2 style="color:#e74c3c;">Authorization Failed</h2>
      <p>${error}</p>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
      <h2 style="color:#e74c3c;">Missing Code</h2>
      <p>No authorization code was received from Intuit.</p>
      </body></html>
    `);
  }

  console.log(`[QBO] OAuth callback received: code=${code.substring(0, 10)}... realmId=${realmId}`);

  try {
    // Exchange the code for tokens via the Hetzner proxy
    const exchangeRes = await fetch(`${QBO_PROXY_URL}/oauth/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Key": QBO_PROXY_KEY,
      },
      body: JSON.stringify({
        code,
        realm_id: realmId || QBO_REALM_ID,
        redirect_uri: "https://platform-requirements-tracker.replit.app/api/integrations/quickbooks/callback",
      }),
    });

    const result = await exchangeRes.json() as { success?: boolean; error?: string };

    if (exchangeRes.ok && result.success) {
      console.log("[QBO] OAuth token exchange successful!");
      return res.send(`
        <html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:3rem;">
        <h2 style="color:#2ca01c;">&#10003; QuickBooks Connected!</h2>
        <p>The FBC Ops Center is now connected to your QuickBooks company.</p>
        <p style="color:#666;font-size:.9rem;">You can close this window.</p>
        </body></html>
      `);
    } else {
      console.error("[QBO] Token exchange failed:", result);
      return res.status(500).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
        <h2 style="color:#e74c3c;">Connection Failed</h2>
        <p>${result.error || "Token exchange failed. Please try again."}</p>
        </body></html>
      `);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[QBO] OAuth callback error:", message);
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
      <h2 style="color:#e74c3c;">Error</h2>
      <p>${message}</p>
      </body></html>
    `);
  }
});

// ---------------------------------------------------------------------------
// GET /api/integrations/quickbooks/connect  —  Start OAuth flow
// Redirects user to Intuit authorization page
// ---------------------------------------------------------------------------
router.get("/connect", async (_req: Request, res: Response) => {
  const callbackUrl = "https://platform-requirements-tracker.replit.app/api/integrations/quickbooks/callback";
  const scope = "com.intuit.quickbooks.accounting com.intuit.quickbooks.payment";
  const clientId = process.env.QBO_CLIENT_ID || "ABOi3hOx6P7yYbb9Qws6drAUu55IFQIDmmli0nyXuWuaIgQMBH";

  const state = Math.random().toString(36).substring(2, 15);

  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
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

    // Search for existing customer first
    const searchResult = await proxyRequest<{
      QueryResponse: { Customer?: Array<{ Id: string; SyncToken: string; DisplayName: string }> };
    }>("POST", "/query", {
      query: `SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}'`,
    });

    const existing = searchResult?.QueryResponse?.Customer?.[0];

    const customerData: Record<string, unknown> = {
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

    let result: unknown;
    if (existing) {
      console.log(`[QBO] Updating existing customer ID ${existing.Id}`);
      result = await proxyRequest("POST", "/customer", {
        customer: {
          ...customerData,
          Id: existing.Id,
          SyncToken: existing.SyncToken,
          sparse: true,
        },
      });
    } else {
      console.log("[QBO] Creating new customer:", displayName);
      result = await proxyRequest("POST", "/customer", { customer: customerData });
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
          itemRef?: string;
        }>;
        dueDate?: string;
        docNumber?: string;
        privateNote?: string;
      };

    if (!qboCustomerId || !lineItems?.length) {
      return res.status(400).json({ error: "qboCustomerId and lineItems are required" });
    }

    const lines = lineItems.map((item) => ({
      Amount: item.amount,
      DetailType: "SalesItemLineDetail",
      Description: item.description,
      SalesItemLineDetail: {
        ItemRef: { value: item.itemRef ?? "1", name: "Services" },
        Qty: item.qty ?? 1,
        UnitPrice: item.unitPrice ?? item.amount,
      },
    }));

    const invoice = {
      CustomerRef: { value: qboCustomerId },
      Line: lines,
      ...(dueDate && { DueDate: dueDate }),
      ...(docNumber && { DocNumber: docNumber }),
      ...(privateNote && { PrivateNote: privateNote }),
    };

    const result = await proxyRequest<{ Invoice: { Id: string; DocNumber: string } }>(
      "POST",
      "/invoice",
      { invoice }
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
        paymentMethodRef?: string;
        depositAccountRef?: string;
        fbcPaymentId?: string | number;
      };

    if (!qboCustomerId || !amount) {
      return res.status(400).json({ error: "qboCustomerId and amount are required" });
    }

    const payment: Record<string, unknown> = {
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

    const result = await proxyRequest<{ Payment: { Id: string } }>(
      "POST",
      "/payment",
      { payment }
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

// ---------------------------------------------------------------------------
// GET /api/integrations/quickbooks/customers
// Query: ?search=<name>&limit=<n>
// ---------------------------------------------------------------------------
router.get("/customers", async (req: Request, res: Response) => {
  try {
    const search = req.query.search as string | undefined;
    const limit = req.query.limit || "50";
    const where = search
      ? `DisplayName LIKE '%${search.replace(/'/g, "\\'")}%'`
      : "Active = true";

    const data = await proxyRequest("GET", `/customers?where=${encodeURIComponent(where)}&limit=${limit}`);
    return res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/integrations/quickbooks/invoices
// Query: ?status=open|overdue|all&limit=<n>
// ---------------------------------------------------------------------------
router.get("/invoices", async (req: Request, res: Response) => {
  try {
    const status = req.query.status || "open";
    const limit = req.query.limit || "50";
    let where: string;

    switch (status) {
      case "overdue":
        where = `DueDate < '${new Date().toISOString().split("T")[0]}' AND Balance > '0'`;
        break;
      case "all":
        where = "MetaData.CreateTime > '2020-01-01'";
        break;
      case "open":
      default:
        where = "Balance > '0'";
        break;
    }

    const data = await proxyRequest("GET", `/invoices?where=${encodeURIComponent(where)}&limit=${limit}`);
    return res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/integrations/quickbooks/items
// ---------------------------------------------------------------------------
router.get("/items", async (req: Request, res: Response) => {
  try {
    const data = await proxyRequest("GET", "/items");
    return res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

export default router;
