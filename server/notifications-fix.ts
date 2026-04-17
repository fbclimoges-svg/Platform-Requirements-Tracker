/**
 * Notifications Fix
 * FBC Home Concept LLC — Ops Center
 *
 * Replaces the broken /api/notifications endpoint that currently returns 500.
 *
 * WIRE UP in server/routes.ts or server/index.ts:
 *
 *   import { notificationsRouter } from './notifications-fix';
 *   app.use('/api', notificationsRouter);
 *
 * This adds:
 *   GET  /api/notifications       — list notifications (with filtering)
 *   PATCH /api/notifications/:id/read  — mark one notification as read
 *   PATCH /api/notifications/read-all  — mark all as read
 *   POST /api/notifications       — create a notification (internal use)
 *   GET  /api/notifications/stats — count of unread (replaces the empty stub)
 *
 * If your database does NOT have a `notifications` table yet, the routes
 * will return empty arrays with a "table_missing" flag so the UI doesn't crash.
 */

import { Router, Request, Response } from "express";

export const notificationsRouter = Router();

// ---------------------------------------------------------------------------
// Type for a notification row
// ---------------------------------------------------------------------------
interface Notification {
  id: number | string;
  user_id?: number | string | null;
  title: string;
  message: string;
  type: string;          // e.g. "info" | "warning" | "error" | "success"
  entity_type?: string | null; // e.g. "job" | "estimate" | "payment"
  entity_id?: number | string | null;
  is_read: boolean;
  created_at: string;
  read_at?: string | null;
}

// ---------------------------------------------------------------------------
// Helper: safely run a DB query and handle "relation does not exist" errors.
// Replace `db` with your actual database client import.
// ---------------------------------------------------------------------------

// TODO: Replace this import with your actual DB client.
// Common patterns:
//   import { db } from './db';         // Drizzle / Knex
//   import pool from './db';           // node-postgres (pg)
//   import { prisma } from './db';     // Prisma
//
// The helper below is written for a `pool.query(sql, params)` style (node-postgres).
// Adjust as needed for your ORM/query builder.

async function safeQuery<T = unknown>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  sql: string,
  params: unknown[] = []
): Promise<{ rows: T[]; tableMissing: boolean }> {
  try {
    const result = await db.query(sql, params);
    return { rows: result.rows as T[], tableMissing: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // PostgreSQL: "relation does not exist" = table not created yet
    if (message.includes("relation") && message.includes("does not exist")) {
      console.warn("[Notifications] Table does not exist yet. Returning empty results.");
      return { rows: [], tableMissing: true };
    }
    // Re-throw unexpected errors
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /api/notifications
// Query params: ?unread=true, ?limit=50, ?offset=0, ?type=warning
// ---------------------------------------------------------------------------
notificationsRouter.get("/notifications", async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req.app.locals as any).db ?? (req.app as any).db;

    if (!db) {
      console.error("[Notifications] No db instance found on app.locals.db");
      return res.status(500).json({
        error: "Database not accessible. Ensure db is attached to app.locals.db.",
        notifications: [],
      });
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
    const offset = parseInt(String(req.query.offset ?? "0"), 10);
    const unreadOnly = req.query.unread === "true";
    const filterType = req.query.type as string | undefined;

    // Build WHERE clauses
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (unreadOnly) {
      conditions.push(`is_read = false`);
    }

    if (filterType) {
      params.push(filterType);
      conditions.push(`type = $${params.length}`);
    }

    // Scope to current user if auth middleware sets req.user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    if (userId) {
      params.push(userId);
      conditions.push(`(user_id = $${params.length} OR user_id IS NULL)`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit, offset);

    const { rows, tableMissing } = await safeQuery<Notification>(
      db,
      `SELECT id, user_id, title, message, type, entity_type, entity_id,
              is_read, created_at, read_at
       FROM notifications
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Count total (for pagination)
    let total = rows.length;
    if (!tableMissing && rows.length === limit) {
      const countParams = params.slice(0, params.length - 2);
      const countResult = await safeQuery<{ count: string }>(
        db,
        `SELECT COUNT(*) as count FROM notifications ${where}`,
        countParams
      );
      total = parseInt(countResult.rows[0]?.count ?? "0", 10);
    }

    return res.json({
      notifications: rows,
      total,
      limit,
      offset,
      tableMissing: tableMissing || undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Notifications] GET /notifications error:", message);
    return res.status(500).json({ error: message, notifications: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/notifications/stats
// Returns unread count (replaces the empty [] stub)
// ---------------------------------------------------------------------------
notificationsRouter.get("/notifications/stats", async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req.app.locals as any).db ?? (req.app as any).db;

    if (!db) {
      return res.json({ unread: 0, total: 0 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    const params: unknown[] = [];
    let userFilter = "";

    if (userId) {
      params.push(userId);
      userFilter = `WHERE (user_id = $1 OR user_id IS NULL)`;
    }

    const { rows: totalRows, tableMissing } = await safeQuery<{ count: string }>(
      db,
      `SELECT COUNT(*) as count FROM notifications ${userFilter}`,
      params
    );

    if (tableMissing) {
      return res.json({ unread: 0, total: 0, tableMissing: true });
    }

    const unreadFilter = userFilter
      ? `${userFilter} AND is_read = false`
      : `WHERE is_read = false`;

    const { rows: unreadRows } = await safeQuery<{ count: string }>(
      db,
      `SELECT COUNT(*) as count FROM notifications ${unreadFilter}`,
      params
    );

    return res.json({
      unread: parseInt(unreadRows[0]?.count ?? "0", 10),
      total: parseInt(totalRows[0]?.count ?? "0", 10),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Notifications] GET /notifications/stats error:", message);
    // Never crash — return zeros so the UI badge doesn't break
    return res.json({ unread: 0, total: 0, error: message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/notifications/read-all
// Mark all notifications as read for the current user
// ---------------------------------------------------------------------------
notificationsRouter.patch("/notifications/read-all", async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req.app.locals as any).db ?? (req.app as any).db;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;

    if (!db) {
      return res.status(500).json({ error: "Database not accessible" });
    }

    const params: unknown[] = [new Date().toISOString()];
    let whereClause = "WHERE is_read = false";

    if (userId) {
      params.push(userId);
      whereClause += ` AND (user_id = $${params.length} OR user_id IS NULL)`;
    }

    const { rows, tableMissing } = await safeQuery<{ count: string }>(
      db,
      `UPDATE notifications SET is_read = true, read_at = $1
       ${whereClause}
       RETURNING id`,
      params
    );

    return res.json({
      success: true,
      markedRead: tableMissing ? 0 : rows.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Notifications] PATCH /notifications/read-all error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/notifications/:id/read
// Mark a single notification as read
// ---------------------------------------------------------------------------
notificationsRouter.patch("/notifications/:id/read", async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req.app.locals as any).db ?? (req.app as any).db;
    const { id } = req.params;

    if (!db) {
      return res.status(500).json({ error: "Database not accessible" });
    }

    const { rows, tableMissing } = await safeQuery<Notification>(
      db,
      `UPDATE notifications
       SET is_read = true, read_at = $1
       WHERE id = $2
       RETURNING id, title, is_read, read_at`,
      [new Date().toISOString(), id]
    );

    if (tableMissing || rows.length === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }

    return res.json({ success: true, notification: rows[0] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Notifications] PATCH /notifications/:id/read error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/notifications
// Create a notification (used internally by the server, e.g. from job events)
// Body: { title, message, type, entityType?, entityId?, userId? }
// ---------------------------------------------------------------------------
notificationsRouter.post("/notifications", async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req.app.locals as any).db ?? (req.app as any).db;
    const { title, message, type = "info", entityType, entityId, userId } = req.body as {
      title?: string;
      message?: string;
      type?: string;
      entityType?: string;
      entityId?: string | number;
      userId?: string | number;
    };

    if (!title || !message) {
      return res.status(400).json({ error: "title and message are required" });
    }

    if (!db) {
      return res.status(500).json({ error: "Database not accessible" });
    }

    const { rows, tableMissing } = await safeQuery<Notification>(
      db,
      `INSERT INTO notifications (user_id, title, message, type, entity_type, entity_id, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, NOW())
       RETURNING *`,
      [userId ?? null, title, message, type, entityType ?? null, entityId ?? null]
    );

    if (tableMissing) {
      return res.status(503).json({
        error: "notifications table does not exist yet. Run migrations first.",
        tableMissing: true,
      });
    }

    return res.status(201).json({ success: true, notification: rows[0] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Notifications] POST /notifications error:", message);
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// SQL: Create notifications table (run once, or add to your migrations)
// ---------------------------------------------------------------------------
export const CREATE_NOTIFICATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'info',  -- info | warning | error | success
  entity_type  TEXT,           -- e.g. 'job', 'estimate', 'payment'
  entity_id    INTEGER,        -- FK to the related entity
  is_read      BOOLEAN NOT NULL DEFAULT false,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id    ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read    ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
`;

export default notificationsRouter;
