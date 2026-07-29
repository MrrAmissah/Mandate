import { randomUUID } from 'node:crypto';

export async function recordSecurityEvent({
  transaction,
  ownership,
  authentication,
  actorType = authentication ? 'API_CREDENTIAL' : 'SYSTEM',
  actorId = authentication?.credentialId,
  requestId,
  type,
  objectType,
  objectId,
  data = {},
  now = new Date()
}) {
  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new TypeError('A security-event actorId is required.');
  }
  const createdAt = now.toISOString();
  const auditEvent = await transaction.appendAudit(ownership, {
    id: `aud_${randomUUID()}`,
    type,
    objectType,
    objectId,
    actorType,
    actorId,
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
