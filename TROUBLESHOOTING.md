# Standing up an x402 service for the Circle marketplace — field notes

Every issue we hit while building and testing this service (a Pangram AI-text
detection API behind Circle's x402/Gateway payment flow), in the order we hit
them. Format: **symptom → cause → fix**. Written so the next person standing up
a marketplace service doesn't lose a day to the same things.

Stack context: Express + `@circle-fin/x402-batching` server middleware, Circle
Gateway facilitator (`gateway-api.circle.com`), buyer side tested with the
`circle` CLI (agent wallet, custodial SCA) v0.0.5.

---

## 1. Server won't start: esbuild platform mismatch

**Symptom.** `npx tsx server.ts` dies with
`You installed esbuild for another platform than the one you're currently using`
(e.g. `@esbuild/aix-ppc64` present, `darwin-arm64` needed).

**Cause.** `node_modules/` was installed on (or copied from) a different
platform. esbuild ships per-platform native binaries.

**Fix.** `rm -rf node_modules && npm install` on the target machine. Never copy
`node_modules` between machines/containers.

## 2. Malformed `payment-signature` header → 500 instead of 402

**Symptom.** A buyer sending a garbage/undecodable `payment-signature` header
gets `500 {"error":"Payment processing error"}` instead of a 402 telling it how
to pay.

**Cause.** The `@circle-fin/x402-batching` middleware (v3.0.4) wraps its whole
payment path in one try/catch that maps *any* throw — including a base64/JSON
parse failure of the header — to a 500.

**Fix.** Pre-validate the header in your own middleware; if it doesn't decode
to JSON, delete it so the SDK treats the request as unpaid and re-issues the
402 with payment requirements (see `requireDynamicPayment` in `server.ts`).
Agents recover from a 402; they give up on a 500.

## 3. `circle services inspect` reports your service "unavailable" (404)

**Symptom.** Service works fine via POST, but
`circle services inspect <url>` says `status: unavailable, httpStatus: 404`.

**Cause.** `inspect` (and marketplace crawlers generally) probe with a bare
**GET** and no body. If your paid route is POST-only, Express 404s the probe.

**Fix (both sides).**
- Server: add a GET handler on the paid route that returns the 402 at your
  minimum price, so probes always see valid payment requirements.
- Client: `inspect` and `pay` both accept `-X POST -d '<body>'` — always pass
  the method explicitly anyway, because `pay` defaulting to the wrong method
  can settle payment and *then* get a 405, burning money for nothing.

## 4. Testnet/mainnet facilitator mismatch

**Symptom.** Buyer wallet can't pay; the 402's `accepts[]` lists networks the
buyer doesn't have.

**Cause.** The facilitator URL bakes the network set into your 402:
`https://gateway-api-testnet.circle.com` advertises testnet chains (Base
Sepolia, Arc testnet, …), `https://gateway-api.circle.com` advertises 11
mainnet chains. The Circle CLI agent wallet is **mainnet**.

**Fix.** Match `FACILITATOR_URL` to where your buyers' money lives. Local
mocked tests → mock facilitator; real-money tests with the CLI → mainnet.

## 5. Buyers with normal (vanilla x402) wallets can't pay you

**Symptom.** `circle services pay` fails with `No Gateway balance found` even
though the buyer has plenty of USDC.

**Cause.** The `x402-batching` middleware publishes **only** the
`GatewayWalletBatched` scheme. That spends from a buyer's **Circle Gateway
balance** (a deposit in the GatewayWallet contract, `0x7777…00eE`), which is
separate from regular wallet USDC. Vanilla USDC sitting at the buyer's address
is invisible to this scheme.

**Fix.** Buyer must deposit first: `circle gateway deposit --amount <n>
--address <wallet> --chain <chain> --method eco|direct`, then pay with
`--chain` matching where the Gateway balance lives. Document this in your
service README — it will be the #1 buyer support question.

## 6. Circle CLI WAF lockout from polling

**Symptom.** Every CLI call that touches the wallet backend starts returning
`Error: Service returned error 502: … <title>Lockout</title>` (a Bootstrap-styled
block page). `services pay` fails with `Could not resolve backing EOA`.

**Cause.** We polled `circle gateway balance` every 10–15s waiting for a
deposit. A WAF on Circle's backend flagged the session. Notably: the block is
keyed to the **CLI session, not your IP** — direct `curl` to
`gateway-api.circle.com` kept returning 200 throughout.

**Fix / prevention.**
- Poll at most once per 60s. A deposit normally lands in well under a minute,
  so 2–3 polls should suffice.
- Once locked, quiet waiting alone may not clear it (ours survived a fully
  silent 40-minute cooldown). What cleared it: **re-login**
  (`circle wallet login <email>` + OTP) to get a fresh session.
- The lockout can **recur without polling**: a day later, a single
  `services pay` (preceded by one `inspect`) hit the Lockout page again —
  the WAF state apparently persists or re-arms on very little traffic.
- The escalated form: `circle wallet login` itself returns **429** with a
  Cloudflare block page, so you can't even get a fresh session. That layer
  looks IP-keyed (unlike the session-keyed Lockout). Recovery: stop *all*
  CLI traffic, wait 30–60 minutes, then try login **once**. If you're in a
  hurry, switching networks (e.g. a phone hotspot → new IP) may get the
  login through.

## 7. Eco deposit stuck in limbo

**Symptom.** `circle gateway deposit --method eco` reports success
("lands on Polygon within ~30 seconds"), the USDC leaves your wallet, but the
Gateway balance stays 0 — for hours.

**Cause.** Eco is two-legged: an on-chain transfer to Circle's eco deposit
address (this leg confirmed — our wallet went 14 → 13 USDC), then an off-chain
crediting leg run by Circle. Ours never credited (2.5h+). There is **no CLI
command to track or cancel** an in-flight eco deposit.

**Fix.** For anything time-sensitive, prefer `--method direct`: an ordinary
on-chain deposit into the GatewayWallet contract on the same chain. It needs
chain finality (~15–20 min on Base for Gateway) but it's deterministic and
auditable — you get `approveTxHash`/`depositTxHash` you can verify yourself.
Keep the eco `transferTxHash` for a support ticket if the credit never appears.

## 8. Gateway balance API flaps; CLI says "No Gateway balance found" even after on-chain finality

**Symptom.** `POST gateway-api.circle.com/v1/balances` alternates between the
real balance and 0 across consecutive reads. `circle services pay` keeps
failing its pre-flight with `No Gateway balance found` long after the deposit
is final on-chain.

**Cause.** The balance REST API appears to be served by inconsistently-synced
indexer nodes, and the CLI trusts that API for its pre-flight check.

**Fix / how to know the truth.** Read the GatewayWallet contract directly —
this is the ground truth the payment will actually settle against:

```ts
// viem, Base mainnet
const GW = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
await client.readContract({
  address: GW,
  abi: parseAbi(["function availableBalance(address,address) view returns (uint256)"]),
  functionName: "availableBalance",
  args: [USDC, depositor],   // for CLI agent wallets: the *backing EOA*, not the SCA
});
```

Two gotchas inside the gotcha:
- For CLI agent wallets the Gateway depositor is the **backing EOA** (shown in
  `circle gateway balance` output), not the SCA address you pass to `--address`.
- Once `availableBalance` > 0 on-chain, the CLI may still refuse for a while.
  Retry `services pay` on a patient loop (≥10 min apart, and make the loop exit
  on any result other than the balance error so you can't double-pay). In our
  case the CLI stayed blind for ~1 hour past on-chain finality before a retry
  finally hit a truthful indexer node and the payment went through.

## 9. Payment succeeded but the seller's Gateway balance is still 0

**Symptom.** The buyer paid, your handler ran, the buyer got the result — but
`availableBalance` for your seller address on the GatewayWallet contract still
reads 0.

**Cause.** This is by design: the scheme is `GatewayWalletBatched`. The
facilitator verifies and *accepts* the payment synchronously (that's what
gates your handler), but the actual USDC transfer settles on-chain in
**batches** later. The buyer's debit and your credit both appear when the next
batch lands.

**Fix.** Nothing to fix — just don't panic-debug it like we did. Check back
later; withdraw with `GatewayClient.withdraw()` once credited.

## 10. Things that protect you as the seller (design notes)

- **Validate the request body *before* demanding payment.** Our `/detect`
  rejects missing/too-short text with 400/422 pre-payment, so nobody pays for a
  request that's doomed to fail.
- **Deterministic dynamic pricing.** Price is a pure function of the request
  body (per-1k-words, rounded up), so the buyer's signed retry quotes the same
  amount as the original 402. If your price depends on anything else (time,
  load), the retry won't match.
- **Settlement happens before your upstream call.** If the upstream
  (Pangram, in our case) fails after USDC settles, return a clear 5xx with a
  refund note and log it — the buyer already paid. Minimize this window by
  doing every possible validation pre-payment.
- **Test the full flow without spending:** (a) a mocked facilitator + mocked
  upstream (see `test/`), and (b) a real-facilitator dress rehearsal with a
  freshly generated *unfunded* key — the client signs a real EIP-712
  authorization, the mainnet facilitator verifies it, and settlement is
  rejected for insufficient balance. That proves every link except the money.

## 11. Marketplace listing

`agents.circle.com/services` is **curated**, not self-serve. Deploy your
service publicly (mainnet facilitator), then submit it via Circle's seller
form: https://forms.gle/7YFzvdmMcn1JH5tF6
