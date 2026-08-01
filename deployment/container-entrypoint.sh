#!/bin/sh
set -eu

MAX_SECRET_BYTES=1048576

load_secret() {
  name="$1"
  file_name="${name}_FILE"
  eval "direct_value=\${$name-}"
  eval "secret_file=\${$file_name-}"

  if [ -n "$direct_value" ] && [ -n "$secret_file" ]; then
    echo "Both $name and $file_name are set; refusing ambiguous secret configuration." >&2
    exit 78
  fi
  if [ -z "$secret_file" ]; then
    return 0
  fi
  if [ ! -r "$secret_file" ] || [ ! -f "$secret_file" ]; then
    echo "$file_name must reference a readable regular file." >&2
    exit 78
  fi
  size=$(wc -c < "$secret_file" | tr -d ' ')
  if [ "$size" -lt 1 ] || [ "$size" -gt "$MAX_SECRET_BYTES" ]; then
    echo "$file_name must contain between 1 and $MAX_SECRET_BYTES bytes." >&2
    exit 78
  fi

  value=$(cat "$secret_file")
  if [ -z "$value" ]; then
    echo "$file_name resolved to an empty secret." >&2
    exit 78
  fi
  export "$name=$value"
  unset "$file_name"
}

load_secret DATABASE_URL
load_secret MANDATE_API_KEY
load_secret MANDATE_PRIVATE_KEY_PEM
load_secret MANDATE_PUBLIC_KEY_PEM

exec "$@"
