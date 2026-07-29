import { DomainError } from '../domain/errors.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || typeof decoded.id !== 'string' || typeof decoded.at !== 'string') {
      throw new Error('Invalid cursor payload.');
    }
    return decoded;
  } catch {
    throw new DomainError('INVALID_CURSOR', 'startingAfter is not a valid cursor.');
  }
}

export function parsePageRequest(url) {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DomainError('INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }

  const rawCursor = url.searchParams.get('startingAfter');
  return {
    limit,
    cursor: rawCursor ? decodeCursor(rawCursor) : null
  };
}

export function paginate(items, { limit, cursor, timestampField }) {
  const ordered = [...items].sort((left, right) => {
    const timeOrder = String(left[timestampField]).localeCompare(String(right[timestampField]));
    return timeOrder || left.id.localeCompare(right.id);
  });

  let startIndex = 0;
  if (cursor) {
    const cursorIndex = ordered.findIndex(
      (item) => item.id === cursor.id && item[timestampField] === cursor.at
    );
    if (cursorIndex === -1) {
      throw new DomainError('INVALID_CURSOR', 'startingAfter does not identify a visible resource.');
    }
    startIndex = cursorIndex + 1;
  }

  const window = ordered.slice(startIndex, startIndex + limit + 1);
  const hasMore = window.length > limit;
  const data = hasMore ? window.slice(0, limit) : window;
  const last = data.at(-1);

  return {
    data,
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor({ id: last.id, at: last[timestampField] })
      : null
  };
}
