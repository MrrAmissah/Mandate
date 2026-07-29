import { DomainError } from '../domain/errors.js';

const ENVIRONMENTS = new Set(['test', 'live']);
const RETRYABLE_CODES = new Set(['40001', '40P01', '23505']);
const ENTITY_KINDS = new Set([
  'apiCredentials',
  'mandates',
  'approvals',
  'decisions',
  'receipts',
  'auditEvents',
  'outboxMessages'
]);

function ownership(value) {
  if (
    !value ||
    typeof value.tenantId !== 'string' ||
    !/^ten_[A-Za-z0-9_-]+$/.test(value.tenantId) ||
    !ENVIRONMENTS.has(value.environment)
  ) {
    throw new TypeError('A valid tenantId and test/live ownership scope is required.');
  }
  return value;
}

function timestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function json(value) {
  return JSON.stringify(value);
}

function credentialFromRow(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    environment: row.environment,
    name: row.name,
    secretHash: row.secret_hash,
    prefix: row.prefix,
    lastFour: row.last_four,
    scopes: row.scopes,
    status: row.status,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
    revokedAt: timestamp(row.revoked_at),
    revocationReason: row.revocation_reason,
    lastUsedAt: timestamp(row.last_used_at)
  };
}

function mandateFromRow(row) {
  return row && {
    id: row.id,
    principalId: row.principal_id,
    agentId: row.agent_id,
    purpose: row.purpose,
    resources: row.resources,
    allowedActions: row.allowed_actions,
    deniedActions: row.denied_actions,
    approvalRequiredActions: row.approval_required_actions,
    constraints: row.constraints,
    validFrom: timestamp(row.valid_from),
    validUntil: timestamp(row.valid_until),
    maxUses: row.max_uses,
    uses: row.uses,
    status: row.status,
    createdAt: timestamp(row.created_at),
    revokedAt: timestamp(row.revoked_at),
    revocationReason: row.revocation_reason
  };
}

function approvalFromRow(row) {
  return row && {
    id: row.id,
    mandateId: row.mandate_id,
    agentId: row.agent_id,
    action: row.action,
    resource: row.resource,
    summary: row.summary,
    status: row.status,
    requestedAt: timestamp(row.requested_at),
    expiresAt: timestamp(row.expires_at),
    decidedAt: timestamp(row.decided_at),
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    consumedAt: timestamp(row.consumed_at),
    consumedByDecisionId: row.consumed_by_decision_id
  };
}

function decisionFromRow(row) {
  return row && {
    id: row.id,
    mandateId: row.mandate_id,
    agentId: row.agent_id,
    action: row.action,
    resource: row.resource,
    context: row.context,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    reason: row.reason,
    approvalId: row.approval_id,
    evaluatedAt: timestamp(row.evaluated_at),
    requestId: row.request_id
  };
}

function receiptFromRow(row) {
  if (!row) return null;
  return { ...row.payload, signature: row.signature };
}

function auditFromRow(row) {
  return row && {
    id: row.id,
    sequence: Number(row.sequence),
    type: row.type,
    objectType: row.object_type,
    objectId: row.object_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    requestId: row.request_id,
    data: row.data,
    createdAt: timestamp(row.created_at)
  };
}

function outboxFromRow(row) {
  return row && {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    auditEventId: row.audit_event_id,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: timestamp(row.available_at),
    lockedBy: row.locked_by,
    lockedAt: timestamp(row.locked_at),
    lockExpiresAt: timestamp(row.lock_expires_at),
    processedAt: timestamp(row.processed_at),
    lastErrorCode: row.last_error_code,
    createdAt: timestamp(row.created_at)
  };
}

const MAPPERS = {
  apiCredentials: credentialFromRow,
  mandates: mandateFromRow,
  approvals: approvalFromRow,
  decisions: decisionFromRow,
  receipts: receiptFromRow,
  auditEvents: auditFromRow,
  outboxMessages: outboxFromRow
};

const TABLES = {
  apiCredentials: 'api_credentials',
  mandates: 'mandates',
  approvals: 'approvals',
  decisions: 'authorization_decisions',
  receipts: 'receipts',
  auditEvents: 'audit_events',
  outboxMessages: 'outbox_messages'
};

const ORDER_COLUMNS = {
  apiCredentials: 'created_at',
  mandates: 'created_at',
  approvals: 'requested_at',
  decisions: 'evaluated_at',
  receipts: 'issued_at',
  auditEvents: 'sequence',
  outboxMessages: 'created_at'
};

class PostgresView {
  constructor(queryable, { lockReads = false } = {}) {
    this.queryable = queryable;
    this.lockReads = lockReads;
  }

  async get(kind, owner, id) {
    if (!ENTITY_KINDS.has(kind)) throw new TypeError(`Unknown entity kind: ${kind}`);
    const scope = ownership(owner);
    const lock = this.lockReads && ['mandates', 'approvals'].includes(kind) ? ' FOR UPDATE' : '';
    const result = await this.queryable.query(
      `SELECT * FROM mandate.${TABLES[kind]} WHERE tenant_id = $1 AND environment = $2 AND id = $3${lock}`,
      [scope.tenantId, scope.environment, id]
    );
    return MAPPERS[kind](result.rows[0]);
  }

  async list(kind, owner) {
    if (!ENTITY_KINDS.has(kind)) throw new TypeError(`Unknown entity kind: ${kind}`);
    const scope = ownership(owner);
    const result = await this.queryable.query(
      `SELECT * FROM mandate.${TABLES[kind]} WHERE tenant_id = $1 AND environment = $2 ORDER BY ${ORDER_COLUMNS[kind]}, id`,
      [scope.tenantId, scope.environment]
    );
    return result.rows.map(MAPPERS[kind]);
  }

  async findCredentialBySecretHash(secretHash) {
    const result = await this.queryable.query(
      'SELECT * FROM mandate.api_credentials WHERE secret_hash = $1',
      [secretHash]
    );
    return credentialFromRow(result.rows[0]);
  }

  async markCredentialUsed(credential, now = new Date()) {
    const result = await this.queryable.query(
      `UPDATE mandate.api_credentials
       SET last_used_at = GREATEST(COALESCE(last_used_at, '-infinity'::timestamptz), $4::timestamptz)
       WHERE tenant_id = $1 AND environment = $2 AND id = $3
         AND status = 'ACTIVE'
         AND (expires_at IS NULL OR expires_at > $4::timestamptz)`,
      [credential.tenantId, credential.environment, credential.id, now.toISOString()]
    );
    return result.rowCount === 1;
  }

  async save(kind, owner, entity) {
    const scope = ownership(owner);
    switch (kind) {
      case 'apiCredentials':
        await this.queryable.query(
          `INSERT INTO mandate.api_credentials
            (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status,
             created_at, expires_at, revoked_at, revocation_reason, last_used_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (tenant_id, environment, id) DO UPDATE SET
             name = EXCLUDED.name, secret_hash = EXCLUDED.secret_hash, prefix = EXCLUDED.prefix,
             last_four = EXCLUDED.last_four, scopes = EXCLUDED.scopes, status = EXCLUDED.status,
             expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at,
             revocation_reason = EXCLUDED.revocation_reason, last_used_at = EXCLUDED.last_used_at`,
          [scope.tenantId, scope.environment, entity.id, entity.name, entity.secretHash, entity.prefix,
            entity.lastFour, entity.scopes, entity.stat≤»="25›Ö•–Å—°•Ãπ≈’ï…ÂÖâ±îπ≈’ï…‰†(ÄÄÄÄÄÄÄÄÄÅÅ%9MIPÅ%9Q<ÅµÖπëÖ—îπ…ïçï•¡—Ã(ÄÄÄÄÄÄÄÄÄÄÄÄ°—ïπÖπ—}•ê∞ÅïπŸ•…Ωπµïπ–∞Å•ê∞Åëïç•Õ•Ωπ}•ê∞ÅµÖπëÖ—ï}•ê∞Å≠ïÂ}•ê∞ÅÖ±ùΩ…•—°¥∞Å¡ÖÂ±ΩÖê∞(ÄÄÄÄÄÄÄÄÄÄÄÄÅÕ•ùπÖ—’…î∞Å•ÕÕ’ïë}Ö–§(ÄÄÄÄÄÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞êÃ∞ê–∞ê‘∞êÿ∞ê‹∞ê‡∞ê‰∞êƒ¿•Ä∞(ÄÄÄÄÄÄÄÄÄÅmÕçΩ¡îπ—ïπÖπ—%ê∞ÅÕçΩ¡îπïπŸ•…Ωπµïπ–∞Åïπ—•—‰π•ê∞Åïπ—•—‰πëïç•Õ•Ωπ%ê∞Åïπ—•—‰πµÖπëÖ—ï%ê∞(ÄÄÄÄÄÄÄÄÄÄÄÅïπ—•—‰π≠ïÂ%ê∞Åïπ—•—‰πÖ±ùΩ…•—°¥∞Å©ÕΩ∏°¡ÖÂ±ΩÖê§∞ÅÕ•ùπÖ—’…î∞Åïπ—•—‰π•ÕÕ’ïë—t(ÄÄÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÄÄÅâ…ïÖ¨Ï(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅçÖÕîÄùÖ’ë•—Ÿïπ—ÃúËÅÏ(ÄÄÄÄÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ≈’ï…ÂÖâ±îπ≈’ï…‰†(ÄÄÄÄÄÄÄÄÄÅÅ%9MIPÅ%9Q<ÅµÖπëÖ—îπÖ’ë•—}ïŸïπ—Ã(ÄÄÄÄÄÄÄÄÄÄÄÄ°—ïπÖπ—}•ê∞ÅïπŸ•…Ωπµïπ–∞Å•ê∞ÅÕï≈’ïπçî∞Å—Â¡î∞ÅΩâ©ïç—}—Â¡î∞ÅΩâ©ïç—}•ê∞ÅÖç—Ω…}—Â¡î∞(ÄÄÄÄÄÄÄÄÄÄÄÄÅÖç—Ω…}•ê∞Å…ï≈’ïÕ—}•ê∞ÅëÖ—Ñ∞Åç…ïÖ—ïë}Ö–§(ÄÄÄÄÄÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞êÃ∞¿∞ê–∞ê‘∞êÿ∞ê‹∞ê‡∞ê‰∞êƒ¿∞êƒƒ§(ÄÄÄÄÄÄÄÄÄÄÅIQUI9%9ÅÕï≈’ïπçïÄ∞(ÄÄÄÄÄÄÄÄÄÅmÕçΩ¡îπ—ïπÖπ—%ê∞ÅÕçΩ¡îπïπŸ•…Ωπµïπ–∞Åïπ—•—‰π•ê∞Åïπ—•—‰π—Â¡î∞Åïπ—•—‰πΩâ©ïç—QÂ¡î∞(ÄÄÄÄÄÄÄÄÄÄÄÅïπ—•—‰πΩâ©ïç—%ê∞Åïπ—•—‰πÖç—Ω…QÂ¡î∞Åïπ—•—‰πÖç—Ω…%ê∞Åïπ—•—‰π…ï≈’ïÕ—%ê∞(ÄÄÄÄÄÄÄÄÄÄÄÅ©ÕΩ∏°ïπ—•—‰πëÖ—ÑÄ¸¸ÅÌÙ§∞Åïπ—•—‰πç…ïÖ—ïë—t(ÄÄÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÄÄÅ…ï—’…∏ÅÏÄ∏∏πÕ—…’ç—’…ïë±Ωπî°ïπ—•—‰§∞ÅÕï≈’ïπçîËÅ9’µâï»°…ïÕ’±–π…Ω›Õl¡tπÕï≈’ïπçî§ÅÙÏ(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅçÖÕîÄùΩ’—âΩ·5ïÕÕÖùïÃúË(ÄÄÄÄÄÄÄÅÖ›Ö•–Å—°•Ãπ≈’ï…ÂÖâ±îπ≈’ï…‰†(ÄÄÄÄÄÄÄÄÄÅÅ%9MIPÅ%9Q<ÅµÖπëÖ—îπΩ’—âΩ·}µïÕÕÖùïÃ(ÄÄÄÄÄÄÄÄÄÄÄÄ°—ïπÖπ—}•ê∞ÅïπŸ•…Ωπµïπ–∞Å•ê∞ÅïŸïπ—}—Â¡î∞ÅÖùù…ïùÖ—ï}—Â¡î∞ÅÖùù…ïùÖ—ï}•ê∞ÅÖ’ë•—}ïŸïπ—}•ê∞(ÄÄÄÄÄÄÄÄÄÄÄÄÅ¡ÖÂ±ΩÖê∞ÅÕ—Ö—’Ã∞ÅÖ——ïµ¡—}çΩ’π–∞ÅÖŸÖ•±Öâ±ï}Ö–∞Å±Ωç≠ïë}â‰∞Å±Ωç≠ïë}Ö–∞Å±Ωç≠}ï·¡•…ïÕ}Ö–∞(ÄÄÄÄÄÄÄÄÄÄÄÄÅ¡…ΩçïÕÕïë}Ö–∞Å±ÖÕ—}ï……Ω…}çΩëî∞Åç…ïÖ—ïë}Ö–§(ÄÄÄÄÄÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞êÃ∞ê–∞ê‘∞êÿ∞ê‹∞ê‡∞ê‰∞êƒ¿∞êƒƒ∞êƒ»∞êƒÃ∞êƒ–∞êƒ‘∞êƒÿ∞êƒ‹•Ä∞(ÄÄÄÄÄÄÄÄÄÅmÕçΩ¡îπ—ïπÖπ—%ê∞ÅÕçΩ¡îπïπŸ•…Ωπµïπ–∞Åïπ—•—‰π•ê∞Åïπ—•—‰πïŸïπ—QÂ¡î∞Åïπ—•—‰πÖùù…ïùÖ—ïQÂ¡î∞(ÄÄÄÄÄÄÄÄÄÄÄÅïπ—•—‰πÖùù…ïùÖ—ï%ê∞Åïπ—•—‰πÖ’ë•—Ÿïπ—%ê∞Å©ÕΩ∏°ïπ—•—‰π¡ÖÂ±ΩÖê§∞Åïπ—•—‰πÕ—Ö—’Ã∞(ÄÄÄÄÄÄÄÄÄÄÄÅïπ—•—‰πÖ——ïµ¡—Ω’π–Ä¸¸Ä¿∞Åïπ—•—‰πÖŸÖ•±Öâ±ï–∞Åïπ—•—‰π±Ωç≠ïë	‰Ä¸¸Åπ’±∞∞(ÄÄÄÄÄÄÄÄÄÄÄÅïπ—•—‰π±Ωç≠ïë–Ä¸¸Åπ’±∞∞Åïπ—•—‰π±Ωç≠·¡•…ïÕ–Ä¸¸Åπ’±∞∞Åïπ—•—‰π¡…ΩçïÕÕïë–Ä¸¸Åπ’±∞∞(ÄÄÄÄÄÄÄÄÄÄÄÅïπ—•—‰π±ÖÕ—……Ω…ΩëîÄ¸¸Åπ’±∞∞Åïπ—•—‰πç…ïÖ—ïë—t(ÄÄÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÄÄÅâ…ïÖ¨Ï(ÄÄÄÄÄÅëïôÖ’±–Ë(ÄÄÄÄÄÄÄÅ—°…Ω‹Åπï‹ÅQÂ¡ï……Ω»°ÅUπ≠πΩ›∏Åïπ—•—‰Å≠•πêËÄëÌ≠•πëıÄ§Ï(ÄÄÄÅÙ(ÄÄÄÅ…ï—’…∏ÅÕ—…’ç—’…ïë±Ωπî°ïπ—•—‰§Ï(ÄÅÙ((ÄÅÖÕÂπåÅÖ¡¡ïπë’ë•–°Ω›πï»∞ÅïŸïπ–§ÅÏ(ÄÄÄÅ…ï—’…∏Å—°•ÃπÕÖŸî†ùÖ’ë•—Ÿïπ—Ãú∞ÅΩ›πï»∞ÅïŸïπ–§Ï(ÄÅÙ((ÄÅÖÕÂπåÅïπ≈’ï’ï=’—âΩ‡°Ω›πï»∞ÅµïÕÕÖùî§ÅÏ(ÄÄÄÅ…ï—’…∏Å—°•ÃπÕÖŸî†ùΩ’—âΩ·5ïÕÕÖùïÃú∞ÅΩ›πï»∞ÅµïÕÕÖùî§Ï(ÄÅÙ((ÄÅÖÕÂπåÅ•ëïµ¡Ω—ïπ–°Ω›πï»∞ÅÕçΩ¡î∞Å≠ï‰∞Åô•πùï…¡…•π–∞Åç…ïÖ—î§ÅÏ(ÄÄÄÅçΩπÕ–Å—ïπÖπ–ÄÙÅΩ›πï…Õ°•¿°Ω›πï»§Ï(ÄÄÄÅ•òÄ†Ö≠ï‰§Å…ï—’…∏ÅÕ—…’ç—’…ïë±Ωπî°Ö›Ö•–Åç…ïÖ—î†§§Ï((ÄÄÄÅçΩπÕ–Åï·•Õ—•πúÄÙÅÖ›Ö•–Å—°•Ãπ≈’ï…ÂÖâ±îπ≈’ï…‰†(ÄÄÄÄÄÅÅM1PÅ…ï≈’ïÕ—}ô•πùï…¡…•π–∞Å…ïÕ¡ΩπÕï}âΩë‰(ÄÄÄÄÄÄÅI=4ÅµÖπëÖ—îπ•ëïµ¡Ω—ïπçÂ}…ïçΩ…ëÃ(ÄÄÄÄÄÄÅ]!IÅ—ïπÖπ—}•êÄÙÄêƒÅ9ÅïπŸ•…Ωπµïπ–ÄÙÄê»Å9ÅÕçΩ¡îÄÙÄêÃÅ9Å•ëïµ¡Ω—ïπçÂ}≠ï‰ÄÙÄê–(ÄÄÄÄÄÄÅ=HÅUAQÄ∞(ÄÄÄÄÄÅm—ïπÖπ–π—ïπÖπ—%ê∞Å—ïπÖπ–πïπŸ•…Ωπµïπ–∞ÅÕçΩ¡î∞Å≠ïÂt(ÄÄÄÄ§Ï(ÄÄÄÅ•òÄ°ï·•Õ—•πúπ…Ω›Õl¡t§ÅÏ(ÄÄÄÄÄÅ•òÄ°ï·•Õ—•πúπ…Ω›Õl¡tπ…ï≈’ïÕ—}ô•πùï…¡…•π–ÄÑÙÙÅô•πùï…¡…•π–§ÅÏ(ÄÄÄÄÄÄÄÅ—°…Ω‹Åπï‹ÅΩµÖ•π……Ω»†(ÄÄÄÄÄÄÄÄÄÄù%5A=Q9e}=91%Pú∞(ÄÄÄÄÄÄÄÄÄÄùQ°•ÃÅ•ëïµ¡Ω—ïπç‰Å≠ï‰Å›ÖÃÅÖ±…ïÖë‰Å’ÕïêÅ›•—†ÅÑÅë•ôôï…ïπ–Å…ï≈’ïÕ–Å¡ÖÂ±ΩÖê∏ú∞(ÄÄÄÄÄÄÄÄÄÄ–¿‰(ÄÄÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅ…ï—’…∏ÅÕ—…’ç—’…ïë±Ωπî°ï·•Õ—•πúπ…Ω›Õl¡tπ…ïÕ¡ΩπÕï}âΩë‰§Ï(ÄÄÄÅÙ((ÄÄÄÅçΩπÕ–ÅŸÖ±’îÄÙÅÖ›Ö•–Åç…ïÖ—î†§Ï(ÄÄÄÅÖ›Ö•–Å—°•Ãπ≈’ï…ÂÖâ±îπ≈’ï…‰†(ÄÄÄÄÄÅÅ%9MIPÅ%9Q<ÅµÖπëÖ—îπ•ëïµ¡Ω—ïπçÂ}…ïçΩ…ëÃ(ÄÄÄÄÄÄÄÄ°—ïπÖπ—}•ê∞ÅïπŸ•…Ωπµïπ–∞ÅÕçΩ¡î∞Å•ëïµ¡Ω—ïπçÂ}≠ï‰∞Å…ï≈’ïÕ—}ô•πùï…¡…•π–∞Å…ïÕ¡ΩπÕï}Õ—Ö—’Ã∞(ÄÄÄÄÄÄÄÄÅ…ïÕ¡ΩπÕï}°ïÖëï…Ã∞Å…ïÕ¡ΩπÕï}âΩë‰∞Åç…ïÖ—ïë}Ö–∞Åï·¡•…ïÕ}Ö–§(ÄÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞êÃ∞ê–∞ê‘∞»¿¿∞ùÌÙúËÈ©ÕΩπà∞êÿ±πΩ‹†§±πΩ‹†§Ä¨Å•π—ï…ŸÖ∞Äú‹ÅëÖÂÃú•Ä∞(ÄÄÄÄÄÅm—ïπÖπ–π—ïπÖπ—%ê∞Å—ïπÖπ–πïπŸ•…Ωπµïπ–∞ÅÕçΩ¡î∞Å≠ï‰∞Åô•πùï…¡…•π–∞Å©ÕΩ∏°ŸÖ±’î•t(ÄÄÄÄ§Ï(ÄÄÄÅ…ï—’…∏ÅÕ—…’ç—’…ïë±Ωπî°ŸÖ±’î§Ï(ÄÅÙ)Ù()ï·¡Ω…–Åç±ÖÕÃÅAΩÕ—ù…ïÕM—Ω…îÅï·—ïπëÃÅAΩÕ—ù…ïÕY•ï‹ÅÏ(ÄÅçΩπÕ—…’ç—Ω»°¡ΩΩ∞∞ÅÏÅµÖ·•µ’µQ…ÖπÕÖç—•Ωπ——ïµ¡—ÃÄÙÄ–ÅÙÄÙÅÌÙ§ÅÏ(ÄÄÄÅÕ’¡ï»°¡ΩΩ∞§Ï(ÄÄÄÅ—°•Ãπ¡ΩΩ∞ÄÙÅ¡ΩΩ∞Ï(ÄÄÄÅ—°•ÃπµÖ·•µ’µQ…ÖπÕÖç—•Ωπ——ïµ¡—ÃÄÙÅµÖ·•µ’µQ…ÖπÕÖç—•Ωπ——ïµ¡—ÃÏ(ÄÅÙ((ÄÅÖÕÂπåÅ—…ÖπÕÖç—•Ω∏°›Ω…¨§ÅÏ(ÄÄÄÅôΩ»Ä°±ï–ÅÖ——ïµ¡–ÄÙÄƒÏÅÖ——ïµ¡–ÄÙÅ—°•ÃπµÖ·•µ’µQ…ÖπÕÖç—•Ωπ——ïµ¡—ÃÏÅÖ——ïµ¡–Ä¨ÙÄƒ§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Åç±•ïπ–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞πçΩππïç–†§Ï(ÄÄÄÄÄÅ—…‰ÅÏ(ÄÄÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ù	%8Å%M=1Q%=8Å1Y0ÅMI%1%i	1ú§Ï(ÄÄÄÄÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å›Ω…¨°πï‹ÅAΩÕ—ù…ïÕY•ï‹°ç±•ïπ–∞ÅÏÅ±Ωç≠IïÖëÃËÅ—…’îÅÙ§§Ï(ÄÄÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ù=55%Pú§Ï(ÄÄÄÄÄÄÄÅ…ï—’…∏ÅÕ—…’ç—’…ïë±Ωπî°…ïÕ’±–§Ï(ÄÄÄÄÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ùI=11	,ú§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÄÄÄÄÅ•òÄ°IQIe	1}=Lπ°ÖÃ°ï……Ω»πçΩëî§ÄòòÅÖ——ïµ¡–ÄÅ—°•ÃπµÖ·•µ’µQ…ÖπÕÖç—•Ωπ——ïµ¡—Ã§ÅçΩπ—•π’îÏ(ÄÄÄÄÄÄÄÅ—°…Ω‹Åï……Ω»Ï(ÄÄÄÄÄÅÙÅô•πÖ±±‰ÅÏ(ÄÄÄÄÄÄÄÅç±•ïπ–π…ï±ïÖÕî†§Ï(ÄÄÄÄÄÅÙ(ÄÄÄÅÙ(ÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»†ùAΩÕ—ù…ïME0Å—…ÖπÕÖç—•Ω∏Å…ï—…‰Å±•µ•–Åï·°Ö’Õ—ïê∏ú§Ï(ÄÅÙ((ÄÅÖÕÂπåÅïπÕ’…ï	ΩΩ—Õ—…Ö¿°ÏÅ—ïπÖπ—%ê∞Å—ïπÖπ—9ÖµîÄÙÄù1ΩçÖ∞Å—ïπÖπ–ú∞ÅïπŸ•…Ωπµïπ–∞Åç…ïëïπ—•Ö∞ÅÙ§ÅÏ(ÄÄÄÅçΩπÕ–ÅÕçΩ¡îÄÙÅΩ›πï…Õ°•¿°ÏÅ—ïπÖπ—%ê∞ÅïπŸ•…Ωπµïπ–ÅÙ§Ï(ÄÄÄÅçΩπÕ–Åç±•ïπ–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞πçΩππïç–†§Ï(ÄÄÄÅ±ï–Å±Ωç≠ïêÄÙÅôÖ±ÕîÏ((ÄÄÄÅ—…‰ÅÏ(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ùM1PÅ¡ù}ÖëŸ•ÕΩ…Â}±Ωç¨°°ÖÕ°—ï·—ï·—ïπëïê†êƒ∞Ä¿§§ú∞ÅlùµÖπëÖ—îÈâΩΩ—Õ—…Ö¿ùt§Ï(ÄÄÄÄÄÅ±Ωç≠ïêÄÙÅ—…’îÏ(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ù	%8ú§Ï(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†(ÄÄÄÄÄÄÄÅÅ%9MIPÅ%9Q<ÅµÖπëÖ—îπ—ïπÖπ—ÃÄ°•ê∞ÅπÖµî∞ÅÕ—Ö—’Ã∞Åç…ïÖ—ïë}Ö–∞Å’¡ëÖ—ïë}Ö–§(ÄÄÄÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞ùQ%Yú±πΩ‹†§±πΩ‹†§§(ÄÄÄÄÄÄÄÄÅ=8Å=91%PÄ°•ê§Å<ÅUAQÅMPÅπÖµîÄÙÅa1UππÖµî∞Å’¡ëÖ—ïë}Ö–ÄÙÅπΩ‹†•Ä∞(ÄÄÄÄÄÄÄÅmÕçΩ¡îπ—ïπÖπ—%ê∞Å—ïπÖπ—9Öµït(ÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†(ÄÄÄÄÄÄÄÅÅ%9MIPÅ%9Q<ÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±Ã(ÄÄÄÄÄÄÄÄÄÄ°—ïπÖπ—}•ê∞ÅïπŸ•…Ωπµïπ–∞Å•ê∞ÅπÖµî∞ÅÕïç…ï—}°ÖÕ†∞Å¡…ïô•‡∞Å±ÖÕ—}ôΩ’»∞ÅÕçΩ¡ïÃ∞ÅÕ—Ö—’Ã∞(ÄÄÄÄÄÄÄÄÄÄÅç…ïÖ—ïë}Ö–∞Åï·¡•…ïÕ}Ö–∞Å…ïŸΩ≠ïë}Ö–∞Å…ïŸΩçÖ—•Ωπ}…ïÖÕΩ∏∞Å±ÖÕ—}’Õïë}Ö–§(ÄÄÄÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞êÃ∞ê–∞ê‘∞êÿ∞ê‹∞ê‡∞ùQ%Yú∞ê‰∞êƒ¿±9U10±9U10±9U10§(ÄÄÄÄÄÄÄÄÅ=8Å=91%PÄ°—ïπÖπ—}•ê∞ÅïπŸ•…Ωπµïπ–∞Å•ê§Å<ÅUAQÅMP(ÄÄÄÄÄÄÄÄÄÄÅπÖµîÄÙÅa1UππÖµî∞(ÄÄÄÄÄÄÄÄÄÄÅÕïç…ï—}°ÖÕ†ÄÙÅMÅ]!8ÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±ÃπÕ—Ö—’ÃÄÙÄùQ%Yú(ÄÄÄÄÄÄÄÄÄÄÄÄÅQ!8Åa1UπÕïç…ï—}°ÖÕ†Å1MÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±ÃπÕïç…ï—}°ÖÕ†Å9∞(ÄÄÄÄÄÄÄÄÄÄÅ¡…ïô•‡ÄÙÅMÅ]!8ÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±ÃπÕ—Ö—’ÃÄÙÄùQ%Yú(ÄÄÄÄÄÄÄÄÄÄÄÄÅQ!8Åa1Uπ¡…ïô•‡Å1MÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±Ãπ¡…ïô•‡Å9∞(ÄÄÄÄÄÄÄÄÄÄÅ±ÖÕ—}ôΩ’»ÄÙÅMÅ]!8ÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±ÃπÕ—Ö—’ÃÄÙÄùQ%Yú(ÄÄÄÄÄÄÄÄÄÄÄÄÅQ!8Åa1Uπ±ÖÕ—}ôΩ’»Å1MÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±Ãπ±ÖÕ—}ôΩ’»Å9∞(ÄÄÄÄÄÄÄÄÄÄÅÕçΩ¡ïÃÄÙÅMÅ]!8ÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±ÃπÕ—Ö—’ÃÄÙÄùQ%Yú(ÄÄÄÄÄÄÄÄÄÄÄÄÅQ!8Åa1UπÕçΩ¡ïÃÅ1MÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±ÃπÕçΩ¡ïÃÅ9∞(ÄÄÄÄÄÄÄÄÄÄÅï·¡•…ïÕ}Ö–ÄÙÅMÅ]!8ÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±ÃπÕ—Ö—’ÃÄÙÄùQ%Yú(ÄÄÄÄÄÄÄÄÄÄÄÄÅQ!8Åa1Uπï·¡•…ïÕ}Ö–Å1MÅµÖπëÖ—îπÖ¡•}ç…ïëïπ—•Ö±Ãπï·¡•…ïÕ}Ö–Å9Ä∞(ÄÄÄÄÄÄÄÅmÕçΩ¡îπ—ïπÖπ—%ê∞ÅÕçΩ¡îπïπŸ•…Ωπµïπ–∞Åç…ïëïπ—•Ö∞π•ê∞Åç…ïëïπ—•Ö∞ππÖµî∞(ÄÄÄÄÄÄÄÄÄÅç…ïëïπ—•Ö∞πÕïç…ï—!ÖÕ†∞Åç…ïëïπ—•Ö∞π¡…ïô•‡∞Åç…ïëïπ—•Ö∞π±ÖÕ—Ω’»∞Åç…ïëïπ—•Ö∞πÕçΩ¡ïÃ∞(ÄÄÄÄÄÄÄÄÄÅç…ïëïπ—•Ö∞πç…ïÖ—ïë–∞Åç…ïëïπ—•Ö∞πï·¡•…ïÕ—t(ÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ù=55%Pú§Ï(ÄÄÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ùI=11	,ú§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÄÄÅ—°…Ω‹Åï……Ω»Ï(ÄÄÄÅÙÅô•πÖ±±‰ÅÏ(ÄÄÄÄÄÅ•òÄ°±Ωç≠ïê§ÅÏ(ÄÄÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†ùM1PÅ¡ù}ÖëŸ•ÕΩ…Â}’π±Ωç¨°°ÖÕ°—ï·—ï·—ïπëïê†êƒ∞Ä¿§§ú∞ÅlùµÖπëÖ—îÈâΩΩ—Õ—…Ö¿ùt§(ÄÄÄÄÄÄÄÄÄÄπçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅç±•ïπ–π…ï±ïÖÕî†§Ï(ÄÄÄÅÙ(ÄÅÙ((ÄÅÖÕÂπåÅç±ΩÕî†§ÅÏ(ÄÄÄÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞πïπê†§Ï(ÄÅÙ)Ù()ï·¡Ω…–ÅÖÕÂπåÅô’πç—•Ω∏Åç…ïÖ—ïAΩÕ—ù…ïÕAΩΩ∞°ÏÅçΩππïç—•ΩπM—…•πú∞ÅµÖ‡ÄÙÄƒ¿∞ÅÕÕ∞ÄÙÅôÖ±ÕîÅÙÄÙÅÌÙ§ÅÏ(ÄÅ•òÄ†ÖçΩππïç—•ΩπM—…•πú§Å—°…Ω‹Åπï‹Å……Ω»†ùQ	M}UI0Å•ÃÅ…ï≈’•…ïêÅôΩ»ÅAΩÕ—ù…ïME0ÅµΩëî∏ú§Ï(ÄÅçΩπÕ–ÅµΩë’±îÄÙÅÖ›Ö•–Å•µ¡Ω…–†ù¡úú§Ï(ÄÅçΩπÕ–ÅAΩΩ∞ÄÙÅµΩë’±îπAΩΩ∞Ä¸¸ÅµΩë’±îπëïôÖ’±–¸πAΩΩ∞Ï(ÄÅ•òÄ†ÖAΩΩ∞§Å—°…Ω‹Åπï‹Å……Ω»†ùQ°îÅ¡úÅ¡Öç≠ÖùîÅë•êÅπΩ–Åï·¡ΩÕîÅAΩΩ∞∏ú§Ï(ÄÅ…ï—’…∏Åπï‹ÅAΩΩ∞°ÏÅçΩππïç—•ΩπM—…•πú∞ÅµÖ‡∞ÅÕÕ∞ÅÙ§Ï)Ù(