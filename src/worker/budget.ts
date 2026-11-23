// A daily budget for background checks. Each check that saves a server costs a few dozen database
// row writes, and the free plan allows 100,000 a day; past that, every write fails until midnight UTC.
// Capping background checks leaves room for everything else (sharing, alerts, owners, the sync).
// Checks people run on the website or through the MCP server don't count: they don't write.

export const DAILY_CHECK_BUDGET = 2000

const today = () => new Date().toISOString().slice(0, 10)

/** Background checks still allowed today (UTC). */
export async function checksLeftToday(db: D1Database): Promise<number> {
  const value = await db.prepare(`SELECT value FROM settings WHERE key = 'checks_day'`).first<string>('value')
  const [day, count] = (value ?? '').split(':')
  return Math.max(0, DAILY_CHECK_BUDGET - (day === today() ? Number(count) || 0 : 0))
}

/** Count one background check against today's budget. */
export async function countCheck(db: D1Database): Promise<void> {
  await db
    .prepare(`INSERT INTO settings (key, value) VALUES ('checks_day', ?1 || ':1')
              ON CONFLICT (key) DO UPDATE SET value = CASE WHEN substr(value, 1, 10) = ?1
                THEN ?1 || ':' || (CAST(substr(value, 12) AS INTEGER) + 1) ELSE ?1 || ':1' END`)
    .bind(today())
    .run()
}
