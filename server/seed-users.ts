/**
 * Seed script — creates default FBC Ops Center user accounts with hashed passwords.
 * Run once via Replit Shell:  npx tsx server/seed-users.ts
 *
 * Uses the same database connection as the main app (reads DATABASE_URL from env).
 */

import { scrypt, randomBytes } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function seed() {
  // Dynamic import so it works regardless of the ORM setup
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("DATABASE_URL not set. Run from Replit where env vars are configured.");
    process.exit(1);
  }

  // Use pg directly for maximum compatibility
  let pg: any;
  try {
    pg = await import("pg");
  } catch {
    console.error("pg not installed. Run: npm install pg");
    process.exit(1);
  }

  const pool = new pg.default.Pool({ connectionString: DATABASE_URL });

  const users = [
    { name: "Daniel Limoges", email: "dan@fbchomeconcept.com", password: "Welcome123!", role: "Owner" },
    { name: "David Feiertag", email: "david@fbchomeconcept.com", password: "Welcome123!", role: "IT Admin" },
  ];

  for (const u of users) {
    const hash = await hashPassword(u.password);
    // Try to update existing user first, then insert if not found
    const updateResult = await pool.query(
      `UPDATE users SET "passwordHash" = $1 WHERE email = $2`,
      [hash, u.email]
    );
    if (updateResult.rowCount === 0) {
      // Also try snake_case column name
      const updateResult2 = await pool.query(
        `UPDATE users SET password_hash = $1 WHERE email = $2`,
        [hash, u.email]
      );
      if (updateResult2.rowCount === 0) {
        console.log(`User ${u.email} not found — inserting...`);
        try {
          await pool.query(
            `INSERT INTO users (name, email, "passwordHash", role, brand, location, "isActive")
             VALUES ($1, $2, $3, $4, 'all', 'all', true)`,
            [u.name, u.email, hash, u.role]
          );
        } catch {
          // Try snake_case
          await pool.query(
            `INSERT INTO users (name, email, password_hash, role, brand, location, is_active)
             VALUES ($1, $2, $3, $4, 'all', 'all', true)`,
            [u.name, u.email, hash, u.role]
          );
        }
      } else {
        console.log(`Updated password for ${u.email} (snake_case column)`);
      }
    } else {
      console.log(`Updated password for ${u.email}`);
    }
  }

  await pool.end();
  console.log("Done! Users seeded with hashed passwords.");
}

seed().catch((err) => {
  console.error("Seed error:", err);
  process.exit(1);
});
