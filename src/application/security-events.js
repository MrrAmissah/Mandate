import { randomUUID } from 'node:crypto';

export async function recordSecurityEvent({
  transaction,
  ownership,
  authentication,
  requestId,
  type,
  objectType,
  objectId,
  data = {},
  now = new Date()
}) {
  const createdAt = now.toISOString();
  const auditEvent = await transaction.appendAudit(ownership, {
    id: `aud_${randomUUID()}`,
    type,
    objectType,
    objectId,
    actorType: 'API_CREDENTIAL',
    actorId: authentication.credentialId,
    requestId,
    data,
    createdAt
  });

  await transaction.enqueueOutbox(ownership, {
    id: `out_${randomUUID()}`,
    eventType: type,
    aggregateType: objectType,
    aggregateId: objectId,
    auditEventId: auditEvent.id,
    payload: {
      eventId: auditEvent.id,
      type,
      objectType,
      objectId,
      requestId,
      createdAt
    },
    status: 'PENDING',
    attemptCount: 0,
    availableAt: createdAt,
    createdAt
  });

  return auditEvent;
}
