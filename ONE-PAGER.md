# Standing up a paid x402 service — what it takes today, and how to make it easy

*Written after shipping one for real (Pangram AI-text detection, pangram.exe.xyz): local build →
real mainnet USDC payment → public deploy → marketplace submission. Detailed war stories in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).*

## Part 1 — Seller's guide: the path that works

**1. Wrap, don't build.** One Express app + `@circle-fin/x402-batching` middleware around your
upstream API. Three routes are enough: a free manifest (`GET /`), a free price preview
(`POST /quote`), and the paid route. Serve `openapi.json` and an HTML landing page for browsers —
both measurably help marketplace listing.

**2. Two rules protect you and your buyers.** (a) *Validate before charging* — reject bad input
with 400/422 **before** the payment middleware runs, so nobody pays for a doomed request.
(b) *Price deterministically* — the buyer signs against your 402's amount and retries; if the same
body doesn't quote the same price, the retry fails.

**3. Patch the three SDK sharp edges** (until fixed upstream): strip undecodable
`payment-signature` headers pre-middleware (the SDK 500s instead of 402ing — agents recover from
402, not 500); add a GET handler on the paid route returning 402 at minimum price (crawlers and
`circle services inspect` probe with bodyless GETs and will mark you "unavailable" otherwise);
set `FACILITATOR_URL` to where your buyers' money actually lives (testnet vs mainnet bakes the
chain list into your 402).

**4. Climb the test ladder — spend money exactly once.**
   1. Mocked facilitator + mocked upstream (free, every commit).
   2. Real facilitator, no payment: check the 402's `accepts[]` (free).
   3. Dress rehearsal with a freshly generated **unfunded** key: real signature, real
      verification, settlement correctly rejected (free — proves every link but the money).
   4. One real paid call. Verify against your own server log, not the client's claim.

**5. Deploy = any HTTPS box.** One env file (API key, payout address, facilitator URL), one
systemd unit, fresh `npm install` on the target (never copy `node_modules` across platforms).
Know that settlement is **batched**: your handler runs when payment is *accepted*; on-chain USDC
arrives with the next batch. Don't panic-debug a zero balance.

**6. Buyers' #1 question will be funding**, not your API: the batching middleware only accepts
Gateway-balance payments, so buyers holding vanilla USDC must `circle gateway deposit` first.
Put that in your README.

## Part 2 — Asks for Circle: where the friction actually is

Ranked by how much time each cost us:

1. **CLI wallet-backend rate limiting is the single worst experience.** Light polling (and later,
   a single `inspect` + `pay`) triggered an HTML "Lockout" page on every wallet call; recovery
   required re-login, and the login endpoint itself then returned 429. Agents poll — that's their
   nature. Give the CLI sane rate limits, JSON errors with `retry-after`, and never lock the
   login path.
2. **Balance truth is inconsistent.** The `/v1/balances` API flapped between real and zero;
   `services pay` pre-flight stayed blind for ~1 hour after the deposit was final on-chain. The
   CLI should read `availableBalance` from the GatewayWallet contract (ground truth) or offer
   `--force`. Also document that for agent wallets the depositor is the *backing EOA*, not the SCA.
3. **Eco deposits are a black box.** Ours left the wallet and never credited (hours, no status
   command, no cancel, no ticket id). In-flight deposits need a trackable status.
4. **SDK fixes** (small, high leverage): return 402 — never 500 — on malformed payment headers;
   handle bodyless GET probes natively; emit actionable error messages.
5. **Ship a seller scaffold.** `npm create x402-service`: validation-before-payment, deterministic
   pricing, quote route, OpenAPI, landing page, mock-facilitator tests, and the unfunded-key dress
   rehearsal script. Everything in Part 1 should be the template's defaults, not tribal knowledge.
6. **A no-money E2E path.** A `services test-pay` (verify without settle) or sandbox buyer wallet
   would let sellers — and CI — prove the full flow without funding anything.
7. **Self-serve listing.** The marketplace is a Google Form today. An automated flow
   (`inspect`-based health checks + metadata from the service's own manifest/OpenAPI) would make
   listing instant and keep the catalog accurate.
8. **Vanilla x402 in the batching middleware.** Sellers using `x402-batching` are invisible to
   buyers holding plain USDC. Either publish both schemes in `accepts[]` or make the buyer
   funding step one CLI command with clear errors.

**The headline:** the protocol works — a $0.10 cross-party payment with cryptographic receipts is
genuinely magic. Nearly all the pain is operational tooling around it, and all of it is fixable.
