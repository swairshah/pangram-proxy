import express from "express";

const NETWORK = "eip155:5042002";
const USDC = "0x3600000000000000000000000000000000000000";
const VERIFYING_CONTRACT = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

const facilitator = express();
facilitator.use(express.json());

facilitator.get("/v1/x402/supported", (_req, res) => {
  res.json({
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: NETWORK,
        extra: {
          verifyingContract: VERIFYING_CONTRACT,
          assets: [{ symbol: "USDC", address: USDC }],
        },
      },
    ],
    extensions: [],
    signers: {},
  });
});

facilitator.post("/v1/x402/verify", (req, res) => {
  console.log("[mock-facilitator] verify amount:", req.body?.paymentRequirements?.amount);
  res.json({ isValid: true, payer: "0xBUYER000000000000000000000000000000000001" });
});

facilitator.post("/v1/x402/settle", (req, res) => {
  console.log("[mock-facilitator] settle amount:", req.body?.paymentRequirements?.amount);
  res.json({
    success: true,
    payer: "0xBUYER000000000000000000000000000000000001",
    transaction: "0xmocktransactionhash",
    network: NETWORK,
  });
});

facilitator.listen(4001, () => console.log("[mock-facilitator] listening on :4001"));

const pangram = express();
pangram.use(express.json());

pangram.post("/task", (_req, res) => {
  res.json({ task_id: "mock-task-1" });
});

pangram.get("/task/:id", (_req, res) => {
  res.json({
    stage: "STAGE_SUCCESS",
    version: "3.0",
    headline: "AI Detected",
    prediction: "We are confident this document was AI-generated",
    prediction_short: "AI",
    fraction_ai: 0.95,
    fraction_ai_assisted: 0.0,
    fraction_human: 0.05,
    num_ai_segments: 1,
    num_ai_assisted_segments: 0,
    num_human_segments: 0,
    windows: [],
  });
});

pangram.listen(4002, () => console.log("[mock-pangram] listening on :4002"));
