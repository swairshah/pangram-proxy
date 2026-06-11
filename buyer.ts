import "dotenv/config";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const url = process.argv[2] ?? "http://localhost:3000/detect";
const text =
  process.argv[3] ??
  "The rapid advancement of artificial intelligence has transformed numerous industries, enabling unprecedented levels of automation and efficiency across various sectors of the global economy.";

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
if (!privateKey) {
  console.error("Set BUYER_PRIVATE_KEY in .env (testnet wallet with Gateway USDC balance)");
  process.exit(1);
}

const client = new GatewayClient({ chain: "arcTestnet", privateKey });

console.log(`Buyer address: ${client.address}`);
const balances = await client.getBalances();
console.log("Balances:", balances);

const { data, status } = await client.pay(url, { method: "POST", body: { text } });
console.log(`Status: ${status}`);
console.log("Data:", JSON.stringify(data, null, 2));
