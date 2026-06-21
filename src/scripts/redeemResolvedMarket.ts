import "../config/env";
import { ENV } from "../config/env";
import RedeemHelper, { RedeemTokenIds } from "../services/redeemHelper";

interface Args {
  conditionId?: string;
  yesTokenId?: string;
  noTokenId?: string;
  outcome?: string;
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--execute") args.execute = true;
    if (arg === "--condition-id") args.conditionId = next;
    if (arg === "--yes-token-id") args.yesTokenId = next;
    if (arg === "--no-token-id") args.noTokenId = next;
    if (arg === "--outcome") args.outcome = next;
  }
  return args;
}

async function fetchTokenIds(conditionId: string): Promise<RedeemTokenIds | null> {
  const response = await fetch(`${ENV.CLOB_HTTP_URL}/markets/${conditionId}`);
  if (!response.ok) return null;
  const market = await response.json() as {
    tokens?: Array<{ token_id?: string; tokenId?: string; outcome?: string }>;
  };
  const tokens = market.tokens || [];
  if (tokens.length < 2) return null;
  return {
    yesTokenId: tokens[0].token_id || tokens[0].tokenId || "",
    noTokenId: tokens[1].token_id || tokens[1].tokenId || "",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const conditionId = args.conditionId || process.env.CONDITION_ID;
  if (!conditionId) {
    throw new Error("Usage: npm run redeem -- --condition-id <id> [--yes-token-id <id> --no-token-id <id>] [--outcome YES|NO|UP|DOWN] [--execute]");
  }

  let tokenIds: RedeemTokenIds | null = args.yesTokenId && args.noTokenId
    ? { yesTokenId: args.yesTokenId, noTokenId: args.noTokenId }
    : await fetchTokenIds(conditionId);

  if (!tokenIds?.yesTokenId || !tokenIds?.noTokenId) {
    throw new Error("Could not resolve token IDs. Pass --yes-token-id and --no-token-id explicitly.");
  }

  const helper = new RedeemHelper();
  const preview = await helper.preview(conditionId, tokenIds, args.outcome || process.env.OUTCOME);
  console.log(JSON.stringify({ mode: args.execute ? "EXECUTE" : "DRY_RUN", wallet: helper.walletAddress, tokenIds, preview }, null, 2));

  if (!args.execute) {
    console.log("Dry run only. Re-run with --execute to send the redeem transaction.");
    return;
  }

  const result = await helper.redeem(conditionId, tokenIds, args.outcome || process.env.OUTCOME);
  console.log(JSON.stringify({ result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
