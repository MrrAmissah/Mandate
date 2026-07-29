function ownership({ tenantId, environment }) {
  if (typeof tenantId !== 'string' || !/^ten_[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new TypeError('tenantId must be an opaque ten_ identifier.');
  }
  if (!['test', 'live'].includes(environment)) {
    throw new TypeError('environment must be test or live.');
  }
  return { tenantId, environment };
}

export async function ensurePostgresBootstrap(store, {
  tenantId,
  tenantName = 'Local tenant',
  environment,
  credential
}) {
  if (!store?.pool || typeof store.pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL store is required.');
  }
  if (!credential || credential.tenantId !== tenantId || credential.environment !== environment) {
    throw new TypeError('The bootstrap credential must belong to the requested tenant and environment.');
  }

  const scope = ownership({ tenantId, environment });
  const client = await store.pool.connect();
  let locked = false;

  try {
    await client.query(
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      ['mandate:bootstrap']
    );
    locked = true;
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
       VALUES ($1,$2,'ACTIVE',now(),now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [scope.tenantId, tenantName]
    );
    await client.query(
      `INSERT INTO mandate.api_credentials
        (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status,
         created_at, expires_at, revoked_at, revocation_reason, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10,NULL,NULL,NULL)
       ON CONFLICT (tenant_id, environment, id) DO UPDATE SET
         name = EXCLUDED.name,
         secret_hash = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
           THEN EXCLUDED.secret_hash ELSE mandate.api_credentials.secret_hash END,
         prefix = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
           THEN EXCLUDED.prefix ELSE mandate.api_credentials.prefix END,
         last_four = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
           THEN EXCLUDED.last_four ELSE mandate.api_credentials.last_four END,
         scopes = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
           THEN EXCLUDED.scopes ELSE mandate.api_credentials.scopes END,
         expires_at = CASE WHEN mandate.api_credentials.status = 'ACTIVE'
           THEN EXCLUDED.expires_at ELSE mandate.api_credentials.expires_at END`,
      [scope.tenantId, scope.environment, credential.id, credential.name,
        credential.secretHash, credential.prefix, credential.lastFour, credential.scopes,
        credential.createdAt, credential.expiresAt]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (locked) {
      await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        ['mandate:bootstrap']
      ).catch(() => {});
    }
    client.release();
  }
}
