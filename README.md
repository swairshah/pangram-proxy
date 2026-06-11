# Pangram x402 Service

Circle marketplace–compatible (x402/USDC) API wrapping [Pangram Labs](https://docs.pangram.com) AI-text detection.

## How it works

1. Agent calls `POST /detect` with `{"text": "..."}` and no payment → server responds `402 Payment Required` with a base64 `PAYMENT-REQUIRED` header listing payment requirements (price, USDC asset, your wallet, supported networks — fetched live from Circle Gateway).
2. Agent signs an EIP-3009 authorization and retries with a `payment-signature` header.
3. Server verifies + settles via Circle Gateway facilitator (gas-free, batched; USDC credited to your Gateway balance), then runs Pangram detection and returns the result.

Price is computed per request: **$0.10 per 1,000 words, rounded up** (Pangram cost: $0.05 per 1,000 words → 2x margin). Same body always yields the same quote, so the buyer's retry matches.

## Endpoints

| Endpoint | Price | Description |
|---|---|---|
| `GET /` | free | Service manifest (JSON); browsers (`Accept: text/html`) get a landing page |
| `GET /openapi.json` | free | OpenAPI 3.1 spec |
| `POST /quote` | free | `{"text": "..."}` → `{words, price}` |
| `POST /detect` | $0.10 / 1k words | AI detection via Pangram |
| `GET /detect` | — | 402 probe response at minimum price (for `circle services inspect` / crawlers) |

## Run

```bash
npm install
cp .env.example .env   # fill in PANGRAM_API_KEY
npm start              # listens on :3000
```

Env vars: `PANGRAM_API_KEY` (required), `SELLER_ADDRESS` (required — your USDC payout wallet), `FACILITATOR_URL` (default testnet; mainnet: `https://gateway-api.circle.com`), `PRICE_PER_1K_WORDS` (default 0.10), `PORT`, `PANGRAM_BASE_URL` (for tests).

## Test

Mocked end-to-end (no network/funds needed):

```bash
npm test
```

Real paid request against a running server (needs a testnet wallet with a Gateway USDC balance — fund via `GatewayClient.deposit()`, USDC faucet: https://faucet.circle.com):

```bash
BUYER_PRIVATE_KEY=0x... npx tsx buyer.ts http://localhost:3000/detect "text to analyze..."
```

Or with the Circle CLI (mainnet agent wallet; requires a Gateway balance — `circle gateway deposit --method eco` lands on Polygon, then pay with `--chain MATIC`; server must run with the mainnet `FACILITATOR_URL`):

```bash
circle services inspect http://localhost:3000/detect -X POST -d '{"text":"..."}'
circle services pay http://localhost:3000/detect -X POST --address <agent-wallet> --chain MATIC \
  --data '{"text":"text to analyze..."}' --output json
```

## Deploy (exe.dev) + go live

1. Deploy, set env vars, switch `FACILITATOR_URL` to `https://gateway-api.circle.com` (mainnet).
2. Submit the service URL to Circle's marketplace via their [seller form](https://forms.gle/7YFzvdmMcn1JH5tF6) — the catalog at agents.circle.com/services is curated.
3. Withdraw earnings from your Gateway balance with `GatewayClient.withdraw()`.

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — field notes on every issue we hit standing this up (esbuild platform mismatch, 500-on-bad-payment-header, GET probes, testnet/mainnet mismatch, Gateway-vs-vanilla balances, CLI WAF lockout, eco deposit limbo, balance-indexer flapping).

## Caveats

- Settlement happens before the Pangram call. If Pangram errors after payment, the buyer gets a 502 with a refund note (rare; mitigated by validating input pre-payment).
- Payment authorizations must be valid ≥7 days (`maxTimeoutSeconds` is set accordingly by the SDK).
