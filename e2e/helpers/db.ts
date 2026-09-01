/**
 * Read-only Postgres read-backs for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231).
 *
 * Used for assertions that must be grounded in canonical business state
 * (issue counts, comment landing) rather than the UI or the API's own views.
 * Never mutates business state directly.
 *
 * Uses the `pg` driver (declared as a root devDependency so the suite is
 * self-contained). Falls back to the sandbox-provided driver at
 * `/workspaces/astratrace/node_modules/pg` if the local install is absent.
 */

import { DB_CONFIG } from "./port-forward";

type PgModule = typeof import("pg");

let pgModule: PgModule | null = null;

async function loadPg(): Promise<PgModule> {
  if (pgModule) return pgModule;
  try {
    const mod = await import("pg");
    pgModule = mod;
    return mod;
  } catch {
    // Sandbox fallback (QA-noted convenience driver).
    const fallback = "/workspaces/astratrace/node_modules/pg";
    const mod = (await import(fallback)) as PgModule;
    pgModule = mod;
    return mod;
  }
}

export interface DbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function connectDb(): Promise<DbClient> {
  const { Client } = await loadPg();
  const client = new Client(DB_CONFIG);
  await client.connect();
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await client.query<T>(sql, params);
      return res.rows;
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}

/** Count issues for a company (canonical business state). */
export async function companyIssueCount(companyId: string): Promise<number> {
  const db = await connectDb();
  try {
    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM issues WHERE company_id = $1",
      [companyId],
    );
    return Number(rows[0]?.count ?? 0);
  } finally {
    await db.close();
  }
}

/** Find issues whose latest comment body references the reply text (no new issue created). */
export async function issueHasCommentContaining(companyId: string, issueId: string, textFragment: string): Promise<boolean> {
  const db = await connectDb();
  try {
    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM issue_comments WHERE company_id = $1 AND issue_id = $2 AND body ILIKE $3",
      [companyId, issueId, `%${textFragment}%`],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  } finally {
    await db.close();
  }
}

/** Whether any issue in the company references the given text (new-work leak check). */
export async function anyIssueReferences(companyId: string, textFragment: string): Promise<boolean> {
  const db = await connectDb();
  try {
    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM issues WHERE company_id = $1 AND (title ILIKE $2 OR description ILIKE $2)",
      [companyId, `%${textFragment}%`],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  } finally {
    await db.close();
  }
}

/** Agent count for a company (canonical). */
export async function companyAgentCount(companyId: string): Promise<number> {
  const db = await connectDb();
  try {
    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM agents WHERE company_id = $1",
      [companyId],
    );
    return Number(rows[0]?.count ?? 0);
  } finally {
    await db.close();
  }
}
