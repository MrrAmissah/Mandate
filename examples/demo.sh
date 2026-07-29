#!/usr/bin/env bash
set -euo pipefail
BASE_URL=${BASE_URL:-http://localhost:8787}
API_KEY=${MANDATE_API_KEY:-local-development-only}

MANDATE=$(curl -sS -X POST "$BASE_URL/v1/mandates" \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-mandate-1' \
  -d '{
    "principalId":"user_prince",
    "agentId":"agent_coder",
    "purpose":"Inspect a repository and open a draft pull request",
    "resources":["github:MrrAmissah/demo-api"],
    "allowedActions":["repository.read","branch.create","commit.create","pull_request.create_draft"],
    "deniedActions":["pull_request.merge","repository.settings.*"],
    "approvalRequiredActions":["commit.create"]
  }')

echo "$MANDATE"
