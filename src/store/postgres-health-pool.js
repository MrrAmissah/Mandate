export async function createPostgresHealthPool({
  connectionString,
  ssl = false,
  connectionTimeoutMillis
} = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL readiness.');
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 100 || connectionTimeoutMillis > 10000) {
    throw new TypeError('connectionTimeoutMillis must be an integer between 100 and 10000.');
  }
  const module = await import('pg');
  const Pool = module.Pool ?? module.default?.Pool;
  if (!Pool) throw new Error('The pg package did not expose Pool.');
  return new Pool({
    connectionString,
    max: 1,
    ssl,
    connectionTimeoutMillis
  });
}
