import "../config/env";
import { ENV } from "../config/env";
import WalletReadinessService from "../services/walletReadiness";

async function main(): Promise<void> {
  const wallet = process.env.WALLET_ADDRESS || ENV.USER_ADDRESS;
  if (!wallet) {
    throw new Error("Set WALLET_ADDRESS or USER_ADDRESS");
  }

  const service = new WalletReadinessService();
  const readiness = await service.check(wallet);

  console.log(JSON.stringify(readiness, null, 2));

  if (!readiness.ready) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
