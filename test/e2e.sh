#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

LOGDIR="${LOGDIR:-.}"
npx tsx test/mocks.ts > "$LOGDIR/mocks.log" 2>&1 &
MOCKS_PID=$!
FACILITATOR_URL=http://localhost:4001 PANGRAM_BASE_URL=http://localhost:4002 PANGRAM_API_KEY=mock-key PORT="${TEST_PORT:-3000}" npx tsx server.ts > "$LOGDIR/server.log" 2>&1 &
SERVER_PID=$!
trap "kill $MOCKS_PID $SERVER_PID 2>/dev/null" EXIT
sleep 5

BODY='{"text":"This is a sample document being tested for AI generated content detection through the paid endpoint."}'

echo "=== 1. unpaid request -> expect 402 with PAYMENT-REQUIRED header ==="
RESP=$(curl -si -X POST http://localhost:${TEST_PORT:-3000}/detect -H "Content-Type: application/json" -d "$BODY")
echo "$RESP" | head -4
PR_HEADER=$(echo "$RESP" | grep -i "^payment-required:" | cut -d' ' -f2 | tr -d '\r')
echo "--- decoded PAYMENT-REQUIRED ---"
echo "$PR_HEADER" | base64 -d
echo

echo "=== 2. craft payment payload from accepts[0] and retry ==="
ACCEPTED=$(echo "$PR_HEADER" | base64 -d | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['accepts'][0]))")
PAYMENT=$(python3 -c "
import json, base64, sys
accepted = json.loads('''$ACCEPTED''')
payload = {'x402Version': 2, 'accepted': accepted, 'payload': {'signature': '0xmock', 'authorization': {}}}
print(base64.b64encode(json.dumps(payload).encode()).decode())
")
curl -s -X POST http://localhost:${TEST_PORT:-3000}/detect -H "Content-Type: application/json" -H "payment-signature: $PAYMENT" -d "$BODY"
echo
echo "=== e2e done ==="
