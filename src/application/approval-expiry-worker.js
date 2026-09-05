import { randomUUID } from 'node:crypto';
import { recordSecurityEvent } from './security-events.js';
import {
  expireNextApproval,
  inspectApprovalExpiryBacklog
} from '../store/approval-expiry.js';

function validateWorkerId(workerId) {
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9:._-]{3,200}$/.test(workerId)) {
    throw new TypeError('workerId must contain 3-200 safe characters.');
  }
  return workerId;
}

function validateScope(scope) {
  if (!scope || !['test', 'live'].includes(scope.environment)) {
    throw new TypeError('Approval expiry workers require a test or live environment scope.');
  }
  if (scope.tenantId !== undefined && !/^ten_[A-Za-z0-9_-]+$/.test(scope.tenantId)) {
    throw new TypeError('tenantId must use the ten_ prefix.');
  }
  return Object.freeze({ environment: scope.environment, tenantId: scope.tenantId });
}

export class ApprovalExpiryWorker {
  constructor({ store, workerId, scope, now = () => new Date() }) {
    if (!store?.transaction) throw new TypeError('A transactional store is required.');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.store = store;
    this.workerId = validateWorkerId(workerId);
    this.scope = validateScope(scope);
    this.now = now;
  }

  async pollOnce() {
    const requestId = `sys_approval_expiry_${randomUUID()}`;
    return this.store.transaction(async (transaction) => {
      const expired = await expireNextApproval(transaction, this.scope, {
        requestId,
        now: this.now()
      });
      if (!expired) return Object.freeze({ status: 'IDLE' });

      const { ownership, approval, assignmentId } = expired;
      await recordSecurityEvent({
        transaction,
        ownership,
        actorType: 'SYSTEM',
        actorId: this.workerId,
        requestId,
        type: 'approval.expired',
        objectType: 'approval',
        objectId: approval.id,
        data: {
          mandateId: approval.mandateId,
          assignmentId,
          expiresAt: approval.expiresAt,
          expiredAt: approval.expiredAt,
          reason: approval.expirationReason
        },
        now: new Date(approval.expiredAt)
      });

      return Object.freeze({
        status: 'EXPIRED',
        ownership,
        approval,
        assignmentId
      });
    });
  }

  async drain({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer between 1 and 1000.');
    }
    const expired = [];
    while (expired.length < limit) {
      const result = await this.pollOnce();
      if (result.status === 'IDLE') break;
      expired.push(result.approval);
    }
    return Object.freeze({ expired, limitReached: expired.length === limit });
  }

  async backlog() {
    return inspectApprovalExpiryBacklog(this.store, this.scope, { now: this.now() });
  }
}
