import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import {
  addApproverGroupMember,
  createApprovalAssignment,
  createApproverGroup,
  createApproverIdentity
} from '../src/application/approval-operations.js';
import {
  assertCredentialUsable,
  createApiCredentialRecord,
  hashApiKey,
  verifyApiKey
} from '../src/auth/api-credentials.js';
import { createStoredApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { PostgresSigningKeyRegistry } from '../src/crypto/signing-key-registry.js';
import { createApprovalRequest } from '../src/domain/approvals.js';
import { issueReceipt } from '../src/domain/receipts.js';
import {
  createDatabaseBackup,
  parseDatabaseBackupConfig,
  parseDatabaseRestoreConfig,
  restoreAndVerifyDatabase,
  runDatabaseTool
} from '../src/deployment/database-recovery.js';
import { ensurePostgresBootstrap } from '../src/store/postgres-bootstrap.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;
const fixedNow = new Date('2026-08-01T12:00:00.000Z');

function suffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

function databaseConnectionUrl(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withServer(store, signer, secret, run) {
  const authenticator = createStoredApiKeyAuthenticator({
    store,
    hashApiKey,
    verifyApiKey,
    assertCredentialUsable,
    now: () => fixedNow
  });
  const server = createServer(createApp({ store, signer, authenticator, now: () => fixedNow }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function createMandate(baseUrl, secret, requestId, idempotencyKey) {
  const response = await fetch(`${baseUrl}/v1/mandates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': secret,
      'x-request-id': requestId,
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify({
      purpose: 'Recovery continuity proof',
      allowedActions: ['repository.read'],
      principalId: 'principal_recovery',
      resources: ['github:owner/recovery-proof'],
      agentId: 'agent_recovery'
    })
  });
  return { response, text: await response.text() };
}

postgresTest('real PostgreSQL dump and restore preserve the recovery snapshot and durable trust state', async (t) => {
  const id = suffix();
  const sourceDatabase = `mandate_recovery_source_${id}`;
  const targetDatabase = `mandate_restore_${id}`;
  const sourceUrl = databaseConnectionUrl(databaseUrl, sourceDatabase);
  const targetUrl = databaseConnectionUrl(databaseUrl, targetDatabase);
  const adminUrl = databaseConnectionUrl(databaseUrl, 'postgres');
  const outputDirectory = await mkdtemp(join(tmpdir(), 'mandate-recovery-drill-'));
  const adminPool = await createPostgresPool({ connectionString: adminUrl, max: 1 });
  let sourcePool;
  let sourceStore;
  let targetPool;
  let targetStore;

  try {
    const authority = await adminPool.query(
      `SELECT rolsuper OR rolcreatedb AS can_create_database
         FROM pg_roles
        WHERE rolname = current_user`
    );
    if (!authority.rows[0]?.can_create_database) {
      t.skip('PostgreSQL recovery drill requires a disposable-database-capable test role.');
      return;
    }

    await adminPool.query(`CREATE DATABASE "${sourceDatabase}" TEMPLATE template0`);
    sourcePool = await createPostgresPool({ connectionString: sourceUrl, max: 4 });
    await applyMigrations(sourcePool, { logger: { log() {} } });
    sourceStore = new PostgresStore(sourcePool);

    const tenantId = `ten_recovery_${id}`;
    const ownership = { tenantId, environment: 'test' };
    const credentialId = `key_recovery_api_${id}`;
    const secret = `recovery-secret-${id}`;
    const idempotencyKey = `recovery-idempotency-${id}`;
    const credential = createApiCredentialRecord({
      id: credentialId,
      tenantId,
      environment: 'test',
      name: 'Recovery drill credential',
      scopes: ['*']
    }, secret, fixedNow);
    await ensurePostgresBootstrap(sourceStore, {
      tenantId,
      tenantName: 'Recovery drill tenant',
      environment: 'test',
      credential
    });
    const authentication = { ...ownership, credentialId, scopes: ['*'] };

    const signer = createReceiptSigner({ keyId: `key_recovery_signer_${id}` });
    const sourceRegistry = new PostgresSigningKeyRegistry(sourcePool, ownership);
    await sourceRegistry.registerActive(signer);

    let first;
    await withServer(sourceStore, signer, secret, async (baseUrl) => {
      first = await createMandate(baseUrl, secret, 'req_recovery_before_backup', idempotencyKey);
      assert.equal(first.response.status, 201);
    });
    const mandate = JSON.parse(first.text);

    const approvalTrustState = await sourceStore.transaction(async (transaction) => {
      const approver = await createApproverIdentity({
        view: transaction,
        ownership,
        authentication,
        input: { displayName: 'Recovery approver', credentialId },
        now: fixedNow
      });
      const group = await createApproverGroup({
        view: transaction,
        ownership,
        input: { name: `Recovery group ${id}` },
        now: fixedNow
      });
      await addApproverGroupMember({
        view: transaction,
        ownership,
        groupId: group.id,
        approverId: approver.id,
        now: fixedNow
      });
      const approval = createApprovalRequest({
        mandateId: mandate.id,
        agentId: mandate.agentId,
        action: 'repository.read',
        resource: 'github:owner/recovery-proof',
        summary: 'Recovery approval assignment proof',
        expiresAt: '2026-08-01T13:00:00.000Z'
      }, fixedNow);
      await transaction.save('approvals', ownership, approval);
      const assignment = await createApprovalAssignment({
        view: transaction,
        ownership,
        approvalId: approval.id,
        assignment: { type: 'GROUP', id: group.id },
        authentication,
        now: fixedNow
      });
      return { approver, group, approval, assignment };
    });

    const decision = {
      id: `dec_recovery_${id}`,
      mandateId: mandate.id,
      agentId: mandate.agentId,
      action: 'repository.read',
      resource: 'github:owner/recovery-proof',
      context: {},
      outcome: 'ALLOW',
      reasonCode: 'ACTION_ALLOWED',
      reason: 'Recovery drill decision.',
      approvalId: null,
      evaluatedAt: fixedNow.toISOString(),
      requestId: 'req_recovery_receipt'
    };
    await sourcePool.query(
      `INSERT INTO mandate.authorization_decisions
        (tenant_id, environment, id, mandate_id, agent_id, action, resource, context, outcome,
         reason_code, reason, approval_id, evaluated_at, request_id)
       VALUES ($1,'test',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenantId, decision.id, decision.mandateId, decision.agentId, decision.action, decision.resource,
        JSON.stringify(decision.context), decision.outcome, decision.reasonCode, decision.reason,
        decision.approvalId, decision.evaluatedAt, decision.requestId]
    );
    const hash = `sha256:${'a'.repeat(64)}`;
    const receipt = issueReceipt({
      decision,
      mandate,
      signer,
      now: fixedNow,
      input: {
        executionStatus: 'SUCCEEDED',
        inputHash: hash,
        outputHash: hash,
        tool: 'github.read_repository',
        provider: 'github'
      }
    });
    const { signature, ...receiptPayload } = receipt;
    await sourcePool.query(
      `INSERT INTO mandate.receipts
        (tenant_id, environment, id, decision_id, mandate_id, key_id, algorithm, payload, signature, issued_at)
       VALUES ($1,'test',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, receipt.id, receipt.decisionId, receipt.mandateId, receipt.keyId, receipt.algorithm,
        JSON.stringify(receiptPayload), signature, receipt.issuedAt]
    );

    const outbox = await sourcePool.query(
      `SELECT id FROM mandate.outbox_messages
       WHERE tenant_id = $1 AND environment = 'test'
       ORDER BY created_at, id LIMIT 1`,
      [tenantId]
    );
    assert.equal(outbox.rowCount, 1);
    const outboxId = outbox.rows[0].id;
    await sourcePool.query(
      `UPDATE mandate.outbox_messages
       SET status = 'DEAD_LETTER', attempt_count = 1, processed_at = $3,
           last_error_code = 'RECOVERY_TEST'
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, outboxId, fixedNow.toISOString()]
    );
    await sourcePool.query(
      `INSERT INTO mandate.outbox_attempts
        (tenant_id, environment, id, outbox_message_id, attempt_number, worker_id, outcome,
         error_code, started_at, completed_at, created_at)
       VALUES ($1,'test',$2,$3,1,'recovery-worker','DEAD_LETTER','RECOVERY_TEST',$4,$4,$4)`,
      [tenantId, `oba_recovery_${id}`, outboxId, fixedNow.toISOString()]
    );

    const backupConfig = parseDatabaseBackupConfig({
      DATABASE_URL: sourceUrl,
      MANDATE_BACKUP_OUTPUT_DIR: outputDirectory,
      MANDATE_BACKUP_LABEL: `recovery-${id}`
    });
    const lateTenantId = `ten_recovery_late_${id}`;
    let injectedAfterSnapshot = false;
    const backup = await createDatabaseBackup(backupConfig, {
      toolRunner: async (command, args, options) => {
        assert.equal(args.includes('--snapshot'), true);
        await sourcePool.query(
          `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
           VALUES ($1,'After snapshot','ACTIVE',$2,$2)`,
          [lateTenantId, fixedNow.toISOString()]
        );
        injectedAfterSnapshot = true;
        await runDatabaseTool(command, args, options);
      }
    });
    assert.equal(injectedAfterSnapshot, true);

    await adminPool.query(`CREATE DATABASE "${targetDatabase}" TEMPLATE template0`);
    const restoreConfig = parseDatabaseRestoreConfig({
      MANDATE_RECOVERY_TARGET_URL: targetUrl,
      MANDATE_RECOVERY_BACKUP_PATH: backup.backupPath
    });
    const restored = await restoreAndVerifyDatabase(restoreConfig);
    assert.equal(restored.targetDatabase, targetDatabase);
    assert.ok(restored.migrations >= 11);

    targetPool = await createPostgresPool({ connectionString: targetUrl, max: 4 });
    targetStore = new PostgresStore(targetPool);
    const lateTenant = await targetPool.query('SELECT id FROM mandate.tenants WHERE id = $1', [lateTenantId]);
    assert.equal(lateTenant.rowCount, 0);

    await withServer(targetStore, signer, secret, async (baseUrl) => {
      const replay = await createMandate(baseUrl, secret, 'req_recovery_after_restore', idempotencyKey);
      assert.equal(replay.response.status, 201);
      assert.equal(replay.text, first.text);
    });

    const restoredApprovalTrust = await targetPool.query(
      `SELECT assignment.id AS assignment_id,
              assignment.source_type,
              assignment.source_id,
              eligibility.approver_id,
              binding.credential_id,
              membership.group_id
       FROM mandate.approval_assignments assignment
       JOIN mandate.approval_assignment_eligibility eligibility
         ON eligibility.tenant_id=assignment.tenant_id
        AND eligibility.environment=assignment.environment
        AND eligibility.assignment_id=assignment.id
       JOIN mandate.approver_credential_bindings binding
         ON binding.tenant_id=assignment.tenant_id
        AND binding.environment=assignment.environment
        AND binding.approver_id=eligibility.approver_id
       JOIN mandate.approver_group_memberships membership
         ON membership.tenant_id=assignment.tenant_id
        AND membership.environment=assignment.environment
        AND membership.group_id=assignment.source_id
        AND membership.approver_id=eligibility.approver_id
       WHERE assignment.tenant_id=$1 AND assignment.environment='test' AND assignment.approval_id=$2`,
      [tenantId, approvalTrustState.approval.id]
    );
    assert.deepEqual(restoredApprovalTrust.rows, [{
      assignment_id: approvalTrustState.assignment.id,
      source_type: 'GROUP',
      source_id: approvalTrustState.group.id,
      approver_id: approvalTrustState.approver.id,
      credential_id: credentialId,
      group_id: approvalTrustState.group.id
    }]);

    const restoredReceipt = await targetPool.query(
      `SELECT key_id, algorithm, payload, signature
       FROM mandate.receipts
       WHERE tenant_id = $1 AND environment = 'test' AND id = $2`,
      [tenantId, receipt.id]
    );
    assert.equal(restoredReceipt.rowCount, 1);
    const restoredRegistry = new PostgresSigningKeyRegistry(targetPool, ownership);
    assert.equal(await restoredRegistry.verifyPayload({
      keyId: restoredReceipt.rows[0].key_id,
      algorithm: restoredReceipt.rows[0].algorithm,
      payload: restoredReceipt.rows[0].payload,
      signature: restoredReceipt.rows[0].signature
    }), true);

    const restoredDeadLetter = await targetPool.query(
      `SELECT message.status, message.last_error_code, attempt.outcome, attempt.error_code
       FROM mandate.outbox_messages message
       JOIN mandate.outbox_attempts attempt
         ON attempt.tenant_id = message.tenant_id
        AND attempt.environment = message.environment
        AND attempt.outbox_message_id = message.id
       WHERE message.tenant_id = $1 AND message.environment = 'test' AND message.id = $2`,
      [tenantId, outboxId]
    );
    assert.deepEqual(restoredDeadLetter.rows, [{
      status: 'DEAD_LETTER',
      last_error_code: 'RECOVERY_TEST',
      outcome: 'DEAD_LETTER',
      error_code: 'RECOVERY_TEST'
    }]);
  } finally {
    await targetStore?.close?.().catch(() => {});
    if (!targetStore) await targetPool?.end?.().catch(() => {});
    await sourceStore?.close?.().catch(() => {});
    if (!sourceStore) await sourcePool?.end?.().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS "${targetDatabase}" WITH (FORCE)`).catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS "${sourceDatabase}" WITH (FORCE)`).catch(() => {});
    await adminPool.end();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
