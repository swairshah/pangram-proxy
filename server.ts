import "dotenv/config";
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { formatUnits } from "viem";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dirname needs Node 20.11+; derive it so Node 18 hosts work too.
const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));

const SELLER_ADDRESS = process.env.SELLER_ADDRESS ?? "";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://gateway-api-testnet.circle.com";
const PANGRAM_API_KEY = process.env.PANGRAM_API_KEY ?? "";
const PRICE_PER_1K_WORDS = Number(process.env.PRICE_PER_1K_WORDS ?? "0.10");
const PORT = Number(process.env.PORT ?? 3000);
const PANGRAM_TASK_URL = `${process.env.PANGRAM_BASE_URL ?? "https://text.external-api.pangram.com"}/task`;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

if (!PANGRAM_API_KEY) {
  console.warn("WARNING: PANGRAM_API_KEY is not set. /detect will fail after payment. Put it in .env before going live.");
}

if (!SELLER_ADDRESS) {
  console.error("SELLER_ADDRESS is not set. Put your USDC payout wallet address in .env.");
  process.exit(1);
}

type PaidRequest = express.Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  facilitatorUrl: FACILITATOR_URL,
  description: "Pangram AI-generated text detection",
});

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function priceFor(text: string): string {
  const blocks = Math.max(1, Math.ceil(wordCount(text) / 1000));
  return `$${(blocks * PRICE_PER_1K_WORDS).toFixed(2)}`;
}

function validateBody(req: express.Request, res: express.Response): string | null {
  const text = (req.body as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: 'Request body must be JSON: {"text": "<text to analyze>"}' });
    return null;
  }
  if (wordCount(text) < 5) {
    res.status(422).json({ error: "Text too short to analyze reliably (minimum 5 words)." });
    return null;
  }
  return text;
}

const requireDynamicPayment: express.RequestHandler = (req, res, next) => {
  const text = validateBody(req, res);
  if (text === null) return;
  // A malformed payment-signature makes the SDK middleware throw and reply 500;
  // strip it so the buyer gets a 402 with payment requirements instead.
  const header = req.headers["payment-signature"];
  if (typeof header === "string") {
    try {
      JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      delete req.headers["payment-signature"];
    }
  }
  return gateway.require(priceFor(text))(req as PaidRequest, res, next);
};

async function pangramDetect(text: string) {
  const submit = await fetch(PANGRAM_TASK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PANGRAM_API_KEY },
    body: JSON.stringify({ text, public_dashboard_link: false }),
  });
  if (!submit.ok) {
    throw new Error(`Pangram task submission failed: ${submit.status} ${await submit.text()}`);
  }
  const { task_id } = (await submit.json()) as { task_id: string };

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await fetch(`${PANGRAM_TASK_URL}/${task_id}`, {
      headers: { "x-api-key": PANGRAM_API_KEY },
    });
    if (!poll.ok) {
      throw new Error(`Pangram task poll failed: ${poll.status} ${await poll.text()}`);
    }
    const result = (await poll.json()) as { stage: string; [k: string]: unknown };
    if (result.stage === "STAGE_SUCCESS") return result;
    if (result.stage === "STAGE_FAILED") {
      throw new Error("Pangram task failed");
    }
  }
  throw new Error("Pangram task timed out");
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(`${PROJECT_DIR}/public`, { index: false }));

app.get("/", (req, res) => {
  // Browsers get the landing page; agents/CLIs (Accept: */* or json) get the manifest.
  if (req.headers.accept?.includes("text/html")) {
    return res.sendFile("index.html", { root: `${PROJECT_DIR}/public` });
  }
  res.json({
    name: "Pangram AI Text Detection",
    description:
      "Detect AI-generated, AI-assisted, and human-written text via Pangram Labs. x402/USDC payment required per request.",
    payment: {
      protocol: "x402",
      facilitator: FACILITATOR_URL,
      currency: "USDC",
      payTo: SELLER_ADDRESS,
    },
    pricing: {
      model: "per 1,000 words (rounded up)",
      pricePer1kWords: `$${PRICE_PER_1K_WORDS.toFixed(2)}`,
      minimum: `$${PRICE_PER_1K_WORDS.toFixed(2)}`,
    },
    endpoints: {
      "GET /": "This manifest (free)",
      "GET /openapi.json": "OpenAPI 3.1 spec (free)",
      "POST /quote": 'Get exact price for a payload (free). Body: {"text": "..."}',
      "POST /detect":
        'AI detection (paid). Body: {"text": "..."}. Unpaid requests receive 402 with payment requirements.',
    },
  });
});

app.get("/openapi.json", (_req, res) => {
  res.sendFile("openapi.json", { root: PROJECT_DIR });
});

app.post("/quote", (req, res) => {
  const text = validateBody(req, res);
  if (text === null) return;
  res.json({ words: wordCount(text), price: priceFor(text), currency: "USDC" });
});

// Discovery probes (e.g. `circle services inspect`, marketplace crawlers) hit GET
// without a body; advertise payment requirements at the minimum price.
app.get("/detect", (req, res, next) =>
  gateway.require(`$${PRICE_PER_1K_WORDS.toFixed(2)}`)(req as PaidRequest, res, next)
);

app.post("/detect", requireDynamicPayment, async (req: PaidRequest, res) => {
  const text = (req.body as { text: string }).text;
  const { payer, amount, network } = req.payment!;
  console.log(`Paid ${formatUnits(BigInt(amount), 6)} USDC by ${payer} on ${network}`);
  try {
    const result = await pangramDetect(text);
    res.json({
      headline: result.headline,
      prediction: result.prediction,
      prediction_short: result.prediction_short,
      fraction_ai: result.fraction_ai,
      fraction_ai_assisted: result.fraction_ai_assisted,
      fraction_human: result.fraction_human,
      num_ai_segments: result.num_ai_segments,
      num_ai_assisted_segments: result.num_ai_assisted_segments,
      num_human_segments: result.num_human_segments,
      windows: result.windows,
      version: result.version,
      payment: { payer, amount_usdc: formatUnits(BigInt(amount), 6), network },
    });
  } catch (err) {
    console.error("Pangram error after settlement:", err);
    res.status(502).json({
      error: "Upstream detection failed after payment was settled. Contact the operator for a refund.",
      detail: String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Pangram x402 service listening at http://localhost:${PORT}`);
  console.log(`Seller: ${SELLER_ADDRESS}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`Price: $${PRICE_PER_1K_WORDS.toFixed(2)} per 1,000 words`);
});
