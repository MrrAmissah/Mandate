/**
 * Small, auditable wildcard matcher.
 * `*` matches any sequence; all other characters are literal.
 */
export function matchesPattern(pattern, value) {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replaceAll('*', '.*')}$`);
  return regex.test(value);
}

export function matchesAny(patterns, value) {
  return patterns.some((pattern) => matchesPattern(pattern, value));
}
