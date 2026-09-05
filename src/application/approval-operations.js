import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import { assertObject, requiredString } from '../domain/validate.js';

const IDENTITY_ID = /^apv_[A-Za-z0-9_-]+$/;
const GROUP_ID = /^apg_[A-Za-z0-9_-]+$/;

function scopedKey(ownership, id) {
  return `${ownership.tenantId}:${ownership.environment}:${id}`;
}

function isPostgres(view) {
  return Boolean(view?.queryable && typeof view.queryable.query === 'function');
}

function map(view, name) {
  const value = view?.state?.[name];
  if (!(value instanceof Map)) throw new TypeError(`Memory approval operations require ${name} state.`);
  return value;
}

function timestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function identityFromRow(row) {
  return row && {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: timestamp(row.created_at),
    disabledAt: timestamp(row.disabled_at),
    disableReason: row.disable_reason ?? null
  };
}

function groupFromRow(row) {
  return row && {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: timestamp(row.created_at),
    disabledAt: timestamp(row.disabled_at),
    disableReason: row.disable_reason ?? null
  };
}

function bindingFromRow(row) {
  return row && {
    id: row.id,
    approverId: row.approver_id,
    credentialId: row.credential_id,
    status: row.status,
    boundAt: timestamp(row.bound_at),
    revokedAt: timestamp(row.revoked_at),
    revocationReason: row.revocation_reason ?? null
  };
}

function assignmentFromRow(row) {
  return row && {
    id: row.id,
    approvalId: row.approval_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status,
    assignedByCredentialId: row.assigned_by_credential_id,
    assignedAt: timestamp(row.assigned_at),
    endedAt: timestamp(row.ended_at),
    endReason: row.end_reason ?? null,
    version: Number(row.version ?? 0)
  };
}

function requireIdentifier(value, pattern, name) {
  const normalized = requiredString(value, name);
  if (!pattern.test(normalized)) throw new DomainError('INVALID_REQUEST', `${name} has an invalid identifier format.`);
  return normalized;
}

function optionalReason(value, name = 'reason') {
  if (value === undefined || value === null) return null;
  const reason = requiredString(value, name);
  if (reason.length > 1000) throw new DomainError('INVALID_REQUEST', `${name} must not exceed 1000 characters.`);
  return reason;
}

function assignmentInput(input) {
  assertObject(input, 'assignment');
  const type = requiredString(input.type, 'assignment.type').toUpperCase();
  if (!['APPROVER', 'GROUP'].includes(type)) {
    throw new DomainError('INVALID_REQUEST', 'assignment.type must be APPROVER or GROUP.');
  }
  const id = type === 'APPROVER'
    ? requireIdentifier(input.id, IDENTITY_ID, 'assignment.id')
    : requireIdentifier(input.id, GROUP_ID, 'assignment.id');
  return { type, id };
}

export async function createApproverIdentity({ view, ownership, authentication, input, now = new Date() }) {
  assertObject(input);
  const displayName = requiredString(input.displayName, 'displayName');
  if (displayName.length > 200) throw new DomainError('INVALID_REQUEST', 'displayName must not exceed 200 characters.');
  const identity = {
    id: `apv_${randomUUID()}`,
    displayName,
    status: 'ACTIVE',
    createdAt: now.toISOString(),
    disabledAt: null,
    disableReason: null
  };

  if (isPostgres(view)) {
    await view.queryable.query(
      `INSERT INTO mandate.approver_identities
        (tenant_id, environment, id, display_name, status, created_at)
       VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
      [ownership.tenantId, ownership.environment, identity.id, identity.displayName, identity.createdAt]
    );
  } else {
    map(view, 'approverIdentities').set(scopedKey(ownership, identity.id), structuredClone({ ...identity, ...ownership }));
  }

  let binding = null;
  const bindCurrent = input.bindCurrentCredential === true;
  const explicitCredential = input.credentialId === undefined ? null : requiredString(input.credentialId, 'credentialId');
  if (bindCurrent && explicitCredential) {
    throw new DomainError('INVALID_REQUEST', 'Use either bindCurrentCredential or credentialId, not both.');
  }
  const credentialId = bindCurrent ? authentication.credentialId : explicitCredential;
  if (credentialId) {
    binding = await bindApproverCredential({
      view, ownership, approverId: identity.id, credentialId, now
    });
  }
  return Object.freeze({ ...identity, binding });
}

export async function listApproverIdentities(view, ownership) {
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `SELECT * FROM mandate.approver_identities
       WHERE tenant_id=$1 AND environment=$2
       ORDER BY created_at, id`,
      [ownership.tenantId, ownership.environment]
    );
    return result.rows.map(identityFromRow);
  }
  const prefix = `${ownership.tenantId}:${ownership.environment}:`;
  return [...map(view, 'approverIdentities').entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => {
      const { tenantId: _tenantId, environment: _environment, ...identity } = value;
      return structuredClone(identity);
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function disableApproverIdentity({ view, ownership, approverId, reason, now = new Date() }) {
  requireIdentifier(approverId, IDENTITY_ID, 'approverId');
  const disableReason = optionalReason(reason) ?? (() => { throw new DomainError('INVALID_REQUEST', 'A disable reason is required.'); })();
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `UPDATE mandate.approver_identities
       SET status='DISABLED', disabled_at=$4, disable_reason=$5
       WHERE tenant_id=$1 AND environment=$2 AND id=$3 AND status='ACTIVE'
       RETURNING *`,
      [ownership.tenantId, ownership.environment, approverId, now.toISOString(), disableReason]
    );
    if (result.rowCount !== 1) throw new DomainError('APPROVER_NOT_FOUND_OR_INACTIVE', 'The approver identity is unavailable.', 404);
    return identityFromRow(result.rows[0]);
  }
  const identities = map(view, 'approverIdentities');
  const key = scopedKey(ownership, approverId);
  const identity = identities.get(key);
  if (!identity || identity.status !== 'ACTIVE') throw new DomainError('APPROVER_NOT_FOUND_OR_INACTIVE', 'The approver identity is unavailable.', 404);
  const updated = { ...identity, status: 'DISABLED', disabledAt: now.toISOString(), disableReason };
  identities.set(key, updated);
  const { tenantId: _tenantId, environment: _environment, ...publicIdentity } = updated;
  return structuredClone(publicIdentity);
}

export async function bindApproverCredential({ view, ownership, approverId, credentialId, now = new Date() }) {
  requireIdentifier(approverId, IDENTITY_ID, 'approverId');
  credentialId = requiredString(credentialId, 'credentialId');
  const credential = await view.get('apiCredentials', ownership, credentialId);
  if (!credential || credential.status !== 'ACTIVE') {
    throw new DomainError('CREDENTIAL_NOT_FOUND_OR_INACTIVE', 'The API credential is unavailable.', 404);
  }
  const identity = await getApproverIdentity(view, ownership, approverId);
  if (!identity || identity.status !== 'ACTIVE') {
    throw new DomainError('APPROVER_NOT_FOUND_OR_INACTIVE', 'The approver identity is unavailable.', 404);
  }
  const binding = {
    id: `apb_${randomUUID()}`,
    approverId,
    credentialId,
    status: 'ACTIVE',
    boundAt: now.toISOString(),
    revokedAt: null,
    revocationReason: null
  };
  if (isPostgres(view)) {
    try {
      await view.queryable.query(
        `INSERT INTO mandate.approver_credential_bindings
          (tenant_id, environment, id, approver_id, credential_id, status, bound_at)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`,
        [ownership.tenantId, ownership.environment, binding.id, approverId, credentialId, binding.boundAt]
      );
    } catch (error) {
      if (error?.code === '23505') throw new DomainError('CREDENTIAL_ALREADY_BOUND', 'The credential already has an active approver binding.', 409);
      throw error;
    }
  } else {
    const bindings = map(view, 'approverCredentialBindings');
    for (const value of bindings.values()) {
      if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
        && value.credentialId === credentialId && value.status === 'ACTIVE') {
        throw new DomainError('CREDENTIAL_ALREADY_BOUND', 'The credential already has an active approver binding.', 409);
      }
    }
    bindings.set(scopedKey(ownership, binding.id), { ...binding, ...ownership });
  }
  return Object.freeze(binding);
}

export async function revokeApproverCredentialBinding({ view, ownership, approverId, credentialId, reason, now = new Date() }) {
  requireIdentifier(approverId, IDENTITY_ID, 'approverId');
  credentialId = requiredString(credentialId, 'credentialId');
  const revocationReason = optionalReason(reason) ?? (() => { throw new DomainError('INVALID_REQUEST', 'A revocation reason is required.'); })();
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `UPDATE mandate.approver_credential_bindings
       SET status='REVOKED', revoked_at=$5, revocation_reason=$6
       WHERE tenant_id=$1 AND environment=$2 AND approver_id=$3 AND credential_id=$4 AND status='ACTIVE'
       RETURNING *`,
      [ownership.tenantId, ownership.environment, approverId, credentialId, now.toISOString(), revocationReason]
    );
    if (result.rowCount !== 1) throw new DomainError('APPROVER_BINDING_NOT_FOUND', 'The active approver credential binding does not exist.', 404);
    return bindingFromRow(result.rows[0]);
  }
  const bindings = map(view, 'approverCredentialBindings');
  for (const [key, value] of bindings.entries()) {
    if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
      && value.approverId === approverId && value.credentialId === credentialId && value.status === 'ACTIVE') {
      const updated = { ...value, status: 'REVOKED', revokedAt: now.toISOString(), revocationReason };
      bindings.set(key, updated);
      const { tenantId: _tenantId, environment: _environment, ...publicBinding } = updated;
      return structuredClone(publicBinding);
    }
  }
  throw new DomainError('APPROVER_BINDING_NOT_FOUND', 'The active approver credential binding does not exist.', 404);
}

export async function getApproverIdentity(view, ownership, approverId) {
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      'SELECT * FROM mandate.approver_identities WHERE tenant_id=$1 AND environment=$2 AND id=$3',
      [ownership.tenantId, ownership.environment, approverId]
    );
    return identityFromRow(result.rows[0]);
  }
  const value = map(view, 'approverIdentities').get(scopedKey(ownership, approverId));
  if (!value) return null;
  const { tenantId: _tenantId, environment: _environment, ...identity } = value;
  return structuredClone(identity);
}

export async function resolveAuthenticatedApprover(view, ownership, credentialId) {
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `SELECT i.*
       FROM mandate.approver_credential_bindings b
       JOIN mandate.approver_identities i
         ON i.tenant_id=b.tenant_id AND i.environment=b.environment AND i.id=b.approver_id
       WHERE b.tenant_id=$1 AND b.environment=$2 AND b.credential_id=$3
         AND b.status='ACTIVE' AND i.status='ACTIVE'`,
      [ownership.tenantId, ownership.environment, credentialId]
    );
    return identityFromRow(result.rows[0]);
  }
  for (const binding of map(view, 'approverCredentialBindings').values()) {
    if (binding.tenantId === ownership.tenantId && binding.environment === ownership.environment
      && binding.credentialId === credentialId && binding.status === 'ACTIVE') {
      const identity = await getApproverIdentity(view, ownership, binding.approverId);
      return identity?.status === 'ACTIVE' ? identity : null;
    }
  }
  return null;
}

export async function createApproverGroup({ view, ownership, input, now = new Date() }) {
  assertObject(input);
  const name = requiredString(input.name, 'name');
  if (name.length > 200) throw new DomainError('INVALID_REQUEST', 'name must not exceed 200 characters.');
  const group = {
    id: `apg_${randomUUID()}`,
    name,
    status: 'ACTIVE',
    createdAt: now.toISOString(),
    disabledAt: null,
    disableReason: null
  };
  if (isPostgres(view)) {
    try {
      await view.queryable.query(
        `INSERT INTO mandate.approver_groups
          (tenant_id, environment, id, name, status, created_at)
         VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
        [ownership.tenantId, ownership.environment, group.id, group.name, group.createdAt]
      );
    } catch (error) {
      if (error?.code === '23505') throw new DomainError('APPROVER_GROUP_NAME_CONFLICT', 'An active approver group already uses this name.', 409);
      throw error;
    }
  } else {
    const groups = map(view, 'approverGroups');
    for (const value of groups.values()) {
      if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
        && value.status === 'ACTIVE' && value.name === name) {
        throw new DomainError('APPROVER_GROUP_NAME_CONFLICT', 'An active approver group already uses this name.', 409);
      }
    }
    groups.set(scopedKey(ownership, group.id), { ...group, ...ownership });
  }
  return Object.freeze(group);
}

export async function listApproverGroups(view, ownership) {
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `SELECT * FROM mandate.approver_groups
       WHERE tenant_id=$1 AND environment=$2
       ORDER BY created_at, id`,
      [ownership.tenantId, ownership.environment]
    );
    return result.rows.map(groupFromRow);
  }
  const prefix = `${ownership.tenantId}:${ownership.environment}:`;
  return [...map(view, 'approverGroups').entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => {
      const { tenantId: _tenantId, environment: _environment, ...group } = value;
      return structuredClone(group);
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function getApproverGroup(view, ownership, groupId) {
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      'SELECT * FROM mandate.approver_groups WHERE tenant_id=$1 AND environment=$2 AND id=$3',
      [ownership.tenantId, ownership.environment, groupId]
    );
    return groupFromRow(result.rows[0]);
  }
  const value = map(view, 'approverGroups').get(scopedKey(ownership, groupId));
  if (!value) return null;
  const { tenantId: _tenantId, environment: _environment, ...group } = value;
  return structuredClone(group);
}

export async function addApproverGroupMember({ view, ownership, groupId, approverId, now = new Date() }) {
  requireIdentifier(groupId, GROUP_ID, 'groupId');
  requireIdentifier(approverId, IDENTITY_ID, 'approverId');
  const group = await getApproverGroup(view, ownership, groupId);
  const identity = await getApproverIdentity(view, ownership, approverId);
  if (!group || group.status !== 'ACTIVE') throw new DomainError('APPROVER_GROUP_NOT_FOUND_OR_INACTIVE', 'The approver group is unavailable.', 404);
  if (!identity || identity.status !== 'ACTIVE') throw new DomainError('APPROVER_NOT_FOUND_OR_INACTIVE', 'The approver identity is unavailable.', 404);
  const membership = {
    id: `agm_${randomUUID()}`,
    groupId,
    approverId,
    status: 'ACTIVE',
    addedAt: now.toISOString(),
    removedAt: null,
    removalReason: null
  };
  if (isPostgres(view)) {
    try {
      await view.queryable.query(
        `INSERT INTO mandate.approver_group_memberships
          (tenant_id, environment, id, group_id, approver_id, status, added_at)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`,
        [ownership.tenantId, ownership.environment, membership.id, groupId, approverId, membership.addedAt]
      );
    } catch (error) {
      if (error?.code === '23505') throw new DomainError('APPROVER_ALREADY_IN_GROUP', 'The approver is already an active member of the group.', 409);
      throw error;
    }
  } else {
    const memberships = map(view, 'approverGroupMemberships');
    for (const value of memberships.values()) {
      if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
        && value.groupId === groupId && value.approverId === approverId && value.status === 'ACTIVE') {
        throw new DomainError('APPROVER_ALREADY_IN_GROUP', 'The approver is already an active member of the group.', 409);
      }
    }
    memberships.set(scopedKey(ownership, membership.id), { ...membership, ...ownership });
  }
  return Object.freeze(membership);
}

export async function removeApproverGroupMember({ view, ownership, groupId, approverId, reason, now = new Date() }) {
  requireIdentifier(groupId, GROUP_ID, 'groupId');
  requireIdentifier(approverId, IDENTITY_ID, 'approverId');
  const removalReason = optionalReason(reason) ?? 'Membership removed';
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `UPDATE mandate.approver_group_memberships
       SET status='REMOVED', removed_at=$5, removal_reason=$6
       WHERE tenant_id=$1 AND environment=$2 AND group_id=$3 AND approver_id=$4 AND status='ACTIVE'
       RETURNING id`,
      [ownership.tenantId, ownership.environment, groupId, approverId, now.toISOString(), removalReason]
    );
    if (result.rowCount !== 1) throw new DomainError('APPROVER_GROUP_MEMBERSHIP_NOT_FOUND', 'The active group membership does not exist.', 404);
  } else {
    const memberships = map(view, 'approverGroupMemberships');
    let found = false;
    for (const [key, value] of memberships.entries()) {
      if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
        && value.groupId === groupId && value.approverId === approverId && value.status === 'ACTIVE') {
        memberships.set(key, { ...value, status: 'REMOVED', removedAt: now.toISOString(), removalReason });
        found = true;
        break;
      }
    }
    if (!found) throw new DomainError('APPROVER_GROUP_MEMBERSHIP_NOT_FOUND', 'The active group membership does not exist.', 404);
  }
  return Object.freeze({ groupId, approverId, status: 'REMOVED', removedAt: now.toISOString(), removalReason });
}

async function eligibleApproversForSource(view, ownership, source) {
  if (source.type === 'APPROVER') {
    const identity = await getApproverIdentity(view, ownership, source.id);
    if (!identity || identity.status !== 'ACTIVE') throw new DomainError('APPROVER_NOT_FOUND_OR_INACTIVE', 'The approver identity is unavailable.', 404);
    return [identity.id];
  }
  const group = await getApproverGroup(view, ownership, source.id);
  if (!group || group.status !== 'ACTIVE') throw new DomainError('APPROVER_GROUP_NOT_FOUND_OR_INACTIVE', 'The approver group is unavailable.', 404);
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `SELECT m.approver_id
       FROM mandate.approver_group_memberships m
       JOIN mandate.approver_identities i
         ON i.tenant_id=m.tenant_id AND i.environment=m.environment AND i.id=m.approver_id
       WHERE m.tenant_id=$1 AND m.environment=$2 AND m.group_id=$3
         AND m.status='ACTIVE' AND i.status='ACTIVE'
       ORDER BY m.approver_id`,
      [ownership.tenantId, ownership.environment, source.id]
    );
    if (result.rowCount === 0) throw new DomainError('APPROVER_GROUP_EMPTY', 'The approver group has no active eligible members.', 409);
    return result.rows.map((row) => row.approver_id);
  }
  const eligible = [];
  for (const membership of map(view, 'approverGroupMemberships').values()) {
    if (membership.tenantId === ownership.tenantId && membership.environment === ownership.environment
      && membership.groupId === source.id && membership.status === 'ACTIVE') {
      const identity = await getApproverIdentity(view, ownership, membership.approverId);
      if (identity?.status === 'ACTIVE') eligible.push(identity.id);
    }
  }
  eligible.sort();
  if (eligible.length === 0) throw new DomainError('APPROVER_GROUP_EMPTY', 'The approver group has no active eligible members.', 409);
  return eligible;
}

async function insertAssignment(view, ownership, assignment, eligibleApproverIds) {
  if (isPostgres(view)) {
    try {
      await view.queryable.query(
        `INSERT INTO mandate.approval_assignments
          (tenant_id, environment, id, approval_id, source_type, source_id, status,
           assigned_by_credential_id, assigned_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,0)`,
        [ownership.tenantId, ownership.environment, assignment.id, assignment.approvalId,
          assignment.sourceType, assignment.sourceId, assignment.assignedByCredentialId, assignment.assignedAt]
      );
      for (const approverId of eligibleApproverIds) {
        await view.queryable.query(
          `INSERT INTO mandate.approval_assignment_eligibility
            (tenant_id, environment, assignment_id, approver_id, snapshot_source_group_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ownership.tenantId, ownership.environment, assignment.id, approverId,
            assignment.sourceType === 'GROUP' ? assignment.sourceId : null, assignment.assignedAt]
        );
      }
    } catch (error) {
      if (error?.code === '23505') throw new DomainError('APPROVAL_ALREADY_ASSIGNED', 'The approval already has an active assignment.', 409);
      throw error;
    }
  } else {
    const assignments = map(view, 'approvalAssignments');
    for (const value of assignments.values()) {
      if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
        && value.approvalId === assignment.approvalId && value.status === 'ACTIVE') {
        throw new DomainError('APPROVAL_ALREADY_ASSIGNED', 'The approval already has an active assignment.', 409);
      }
    }
    assignments.set(scopedKey(ownership, assignment.id), { ...assignment, ...ownership });
    const eligibility = map(view, 'approvalAssignmentEligibility');
    for (const approverId of eligibleApproverIds) {
      eligibility.set(`${scopedKey(ownership, assignment.id)}:${approverId}`, {
        ...ownership,
        assignmentId: assignment.id,
        approverId,
        snapshotSourceGroupId: assignment.sourceType === 'GROUP' ? assignment.sourceId : null,
        createdAt: assignment.assignedAt
      });
    }
  }
}

export async function createApprovalAssignment({
  view, ownership, approvalId, assignment: rawAssignment, authentication, now = new Date()
}) {
  const source = assignmentInput(rawAssignment);
  const eligibleApproverIds = await eligibleApproversForSource(view, ownership, source);
  const assignment = {
    id: `apa_${randomUUID()}`,
    approvalId,
    sourceType: source.type,
    sourceId: source.id,
    status: 'ACTIVE',
    assignedByCredentialId: authentication.credentialId,
    assignedAt: now.toISOString(),
    endedAt: null,
    endReason: null,
    version: 0
  };
  await insertAssignment(view, ownership, assignment, eligibleApproverIds);
  return Object.freeze({ ...assignment, eligibleApproverIds: Object.freeze([...eligibleApproverIds]) });
}

export async function getActiveApprovalAssignment(view, ownership, approvalId, { lock = false } = {}) {
  let assignment;
  let eligibleApproverIds = [];
  if (isPostgres(view)) {
    const result = await view.queryable.query(
      `SELECT * FROM mandate.approval_assignments
       WHERE tenant_id=$1 AND environment=$2 AND approval_id=$3 AND status='ACTIVE'${lock ? ' FOR UPDATE' : ''}`,
      [ownership.tenantId, ownership.environment, approvalId]
    );
    assignment = assignmentFromRow(result.rows[0]);
    if (!assignment) return null;
    const eligibility = await view.queryable.query(
      `SELECT approver_id FROM mandate.approval_assignment_eligibility
       WHERE tenant_id=$1 AND environment=$2 AND assignment_id=$3 ORDER BY approver_id`,
      [ownership.tenantId, ownership.environment, assignment.id]
    );
    eligibleApproverIds = eligibility.rows.map((row) => row.approver_id);
  } else {
    for (const value of map(view, 'approvalAssignments').values()) {
      if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
        && value.approvalId === approvalId && value.status === 'ACTIVE') {
        const { tenantId: _tenantId, environment: _environment, ...publicAssignment } = value;
        assignment = structuredClone(publicAssignment);
        break;
      }
    }
    if (!assignment) return null;
    for (const value of map(view, 'approvalAssignmentEligibility').values()) {
      if (value.tenantId === ownership.tenantId && value.environment === ownership.environment
        && value.assignmentId === assignment.id) eligibleApproverIds.push(value.approverId);
    }
    eligibleApproverIds.sort();
  }
  return Object.freeze({ ...assignment, eligibleApproverIds: Object.freeze(eligibleApproverIds) });
}

async function endAssignment(view, ownership, assignment, status, reason, now) {
  if (isPostgres(view)) {
    await view.queryable.query(
      `UPDATE mandate.approval_assignments
       SET status=$4, ended_at=$5, end_reason=$6, version=version+1
       WHERE tenant_id=$1 AND environment=$2 AND id=$3 AND status='ACTIVE'`,
      [ownership.tenantId, ownership.environment, assignment.id, status, now.toISOString(), reason]
    );
  } else {
    const assignments = map(view, 'approvalAssignments');
    const key = scopedKey(ownership, assignment.id);
    const value = assignments.get(key);
    if (value?.status === 'ACTIVE') {
      assignments.set(key, { ...value, status, endedAt: now.toISOString(), endReason: reason, version: value.version + 1 });
    }
  }
}

export async function reassignApproval({ view, ownership, approval, input, authentication, now = new Date() }) {
  assertObject(input);
  if (approval.status !== 'PENDING') throw new DomainError('APPROVAL_NOT_PENDING', 'Only a pending approval can be reassigned.', 409);
  if (approval.expiresAt && Date.parse(now) >= Date.parse(approval.expiresAt)) {
    throw new DomainError('APPROVAL_EXPIRED', 'This approval request has expired.', 409);
  }
  const previous = await getActiveApprovalAssignment(view, ownership, approval.id, { lock: true });
  if (!previous) throw new DomainError('APPROVAL_UNASSIGNED', 'The approval has no active assignment.', 409);
  const reason = optionalReason(input.reason) ?? 'Approval reassigned';
  await endAssignment(view, ownership, previous, 'SUPERSEDED', reason, now);
  try {
    const replacement = await createApprovalAssignment({
      view,
      ownership,
      approvalId: approval.id,
      assignment: input.assignment,
      authentication,
      now
    });
    return Object.freeze({ previousAssignmentId: previous.id, assignment: replacement });
  } catch (error) {
    throw error;
  }
}

export async function cancelApprovalOperation({ view, ownership, approval, input, authentication, now = new Date() }) {
  assertObject(input);
  if (approval.status !== 'PENDING') throw new DomainError('APPROVAL_NOT_PENDING', 'Only a pending approval can be cancelled.', 409);
  if (approval.expiresAt && Date.parse(now) >= Date.parse(approval.expiresAt)) {
    throw new DomainError('APPROVAL_EXPIRED', 'This approval request has expired.', 409);
  }
  const reason = optionalReason(input.reason) ?? (() => { throw new DomainError('INVALID_REQUEST', 'A cancellation reason is required.'); })();
  const assignment = await getActiveApprovalAssignment(view, ownership, approval.id, { lock: true });
  if (assignment) await endAssignment(view, ownership, assignment, 'CANCELLED', reason, now);
  const cancelled = {
    ...approval,
    status: 'CANCELLED',
    cancelledAt: now.toISOString(),
    cancelledByCredentialId: authentication.credentialId,
    cancellationReason: reason
  };
  await view.save('approvals', ownership, cancelled);
  if (isPostgres(view)) {
    await view.queryable.query(
      `UPDATE mandate.approvals
       SET cancelled_at=$4, cancelled_by_credential_id=$5, cancellation_reason=$6
       WHERE tenant_id=$1 AND environment=$2 AND id=$3`,
      [ownership.tenantId, ownership.environment, approval.id, cancelled.cancelledAt,
        cancelled.cancelledByCredentialId, cancelled.cancellationReason]
    );
  }
  return Object.freeze(cancelled);
}

export async function decideAssignedApproval({
  view, ownership, approval, input, authentication, decide, now = new Date()
}) {
  assertObject(input);
  if (Object.hasOwn(input, 'decidedBy')) {
    throw new DomainError('INVALID_REQUEST', 'decidedBy is server-derived and must not be supplied by the caller.');
  }
  const approver = await resolveAuthenticatedApprover(view, ownership, authentication.credentialId);
  if (!approver) throw new DomainError('APPROVER_IDENTITY_REQUIRED', 'The authenticated credential is not bound to an active approver identity.', 403);
  const assignment = await getActiveApprovalAssignment(view, ownership, approval.id, { lock: true });
  if (!assignment) throw new DomainError('APPROVAL_UNASSIGNED', 'The approval has no active assignment.', 409);
  if (!assignment.eligibleApproverIds.includes(approver.id)) {
    throw new DomainError('APPROVER_NOT_ELIGIBLE', 'The authenticated approver is not eligible for this approval assignment.', 403);
  }
  const decided = decide(approval, { ...input, decidedBy: approver.id }, now);
  await view.save('approvals', ownership, decided);
  if (isPostgres(view)) {
    await view.queryable.query(
      `UPDATE mandate.approvals
       SET decided_by_approver_id=$4
       WHERE tenant_id=$1 AND environment=$2 AND id=$3`,
      [ownership.tenantId, ownership.environment, approval.id, approver.id]
    );
  } else {
    await view.save('approvals', ownership, { ...decided, decidedByApproverId: approver.id });
  }
  return Object.freeze({
    approval: Object.freeze({ ...decided, decidedByApproverId: approver.id }),
    approver,
    assignment
  });
}
