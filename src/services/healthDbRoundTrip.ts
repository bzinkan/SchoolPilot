interface HealthRoundTripDatabase {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Uses the caller's existing pool and preserves missing-table bootstrap failures. */
export async function checkHealthDatabaseRoundTrip(database: HealthRoundTripDatabase): Promise<{ ok: true; latencyMs: number }> {
  const start = Date.now();
  const existing = await database.query("SELECT to_regclass('public._health_sentinel') IS NOT NULL AS present");
  if (existing.rows[0]?.present !== true) {
    await database.query(`CREATE TABLE IF NOT EXISTS public._health_sentinel (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  }
  const { rows } = await database.query("INSERT INTO public._health_sentinel DEFAULT VALUES RETURNING id");
  const id = rows[0]!.id;
  const read = await database.query("SELECT id FROM public._health_sentinel WHERE id = $1", [id]);
  if (read.rows.length === 0) {
    throw new Error("Sentinel row not found on read-back");
  }
  await database.query("DELETE FROM public._health_sentinel WHERE id = $1", [id]);
  await database.query("DELETE FROM public._health_sentinel WHERE created_at < NOW() - INTERVAL '1 hour'");
  return { ok: true, latencyMs: Date.now() - start };
}
