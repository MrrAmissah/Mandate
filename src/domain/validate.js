import { DomainError } from './errors.js';

export function assertObject(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_REQUEST', `${name} must be a JSON object.`);
  }
  return value;
}

export function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('INVALID_REQUEST', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

export function stringArray(value, name, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new DomainError('INVALID_REQUEST', `${name} must be an array of non-empty strings.`);
  }
  if (value.length < min) {
    throw new DomainError('INVALID_REQUEST', `${name} must contain at least ${min} item(s).`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function optionalIsoDate(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DomainError('INVALID_REQUEST', `${name} must be an ISO-8601 date string.`);
  }
  return new Date(value).toISOString();
}

export function sha256String(value, name) {
  const normalized = requiredString(value, name);
  if (!/^sha256:[a-f0-9]{64}$/i.test(normalized)) {
    throw new DomainError('INVALID_REQUEST', `${name} must use the format sha256:<64 hex characters>.`);
  }
  return normalized.toLowerCase();
}
