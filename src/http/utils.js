import { randomUUID } from 'node:crypto';
import { canonicalize } from '../crypto/canonical-json.js';
import { hashJson } from '../domain/receipts.js';
import { DomainError } from '../domain/errors.js';

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256_000) throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KB.', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must contain valid JSON.');
  }
}

export function requestFingerprint({ method, pathname, body }) {
  return hashJson({ method, pathname, body: JSON.parse(canonicalize(body)) });
}

export function resolveRequestId(headerValue) {
  if (typeof headerValue === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(headerValue)) {
    return headerValue;
  }
  return `req_${randomUUID()}`;
}

export function sendJson(response, status, body, extraHeaders = {}) {
  const payload = canonicalize(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...extraHeaders
  });
  response.end(payload);
}

export function routeMatch(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}
