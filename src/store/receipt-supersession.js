function isPostgres(value) {
  return Boolean(value?.queryable || value?.pool);
}

function queryable(value) {
  return value.queryable ?? value.pool;
}

function receiptFromRow(row) {
  return row ? { ...row.payload, signature: row.signature } : null;
}

export async function lockReceiptForSupersession(transaction, ownership, receiptId) {
  if (!isPostgres(transaction)) return transaction.get('receipts', ownership, receiptId);
  const result = await queryable(transaction).query(
    `SELECT payload, signature
     FROM mandate.receipts
     WHERE tenant_id = $1 AND environment = $2 AND id = $3
     FOR UPDATE`,
    [ownership.tenantId, ownership.environment, receiptId]
  );
  return receiptFromRow(result.rows[0]);
}

export async function findReceiptSuccessor(store, ownership, receiptId) {
  if (!isPostgres(store)) {
    return (await store.list('receipts', ownership))
      .find((receipt) => receipt.supersedesReceiptId === receiptId) ?? null;
  }
  const result = await queryable(store).query(
    `SELECT payload, signature
     FROM mandate.receipts
     WHERE tenant_id = $1 AND environment = $2 AND supersedes_receipt_id = $3`,
    [ownership.tenantId, ownership.environment, receiptId]
  );
  return receiptFromRow(result.rows[0]);
}

export async function saveSupersedingReceipt(store, ownership, receipt) {
  if (!isPostgres(store)) return store.save('receipts', ownership, receipt);
  const { signature, ...payload } = receipt;
  const result = await queryable(store).query(
    `INSERT INTO mandate.receipts
      (tenant_id, environment, id, decision_id, mandate_id, action_attempt_id, key_id,
       algorithm, payload, signature, issued_at, supersedes_receipt_id, supersession_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING payload, signature`,
    [ownership.tenantId, ownership.environment, receipt.id, receipt.decisionId,
      receipt.mandateId, receipt.actionAttemptId, receipt.keyId, receipt.algorithm,
      JSON.stringify(payload), signature, receipt.issuedAt,
      receipt.supersedesReceiptId, receipt.supersessionReason]
  );
  return receiptFromRow(result.rows[0]);
}
