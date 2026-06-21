import { ethers } from "ethers";
import {
  CONDITIONAL_TOKENS,
  POLYGON_USDCE,
} from "./walletReadiness";
import { ENV } from "../config/env";

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
  "function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

export type RedeemOutcome = "YES" | "NO";

export interface RedeemTokenIds {
  yesTokenId: string;
  noTokenId: string;
}

export interface RedeemPreview {
  conditionId: string;
  resolved: boolean;
  winningOutcome?: RedeemOutcome;
  yesBalance: number;
  noBalance: number;
  redeemableBalance: number;
}

export interface RedeemExecution extends RedeemPreview {
  txHash: string;
  gasUsed?: string;
}

function normalizeOutcome(outcome?: string): RedeemOutcome | undefined {
  const normalized = outcome?.trim().toUpperCase();
  if (!normalized) return undefined;
  if (normalized === "YES" || normalized === "UP") return "YES";
  if (normalized === "NO" || normalized === "DOWN") return "NO";
  throw new Error(`Unsupported outcome "${outcome}". Use YES/NO or UP/DOWN.`);
}

export class RedeemHelper {
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly ctf: ethers.Contract;

  constructor(privateKey: string = ENV.PRIVATE_KEY, rpcUrl: string = ENV.RPC_URL) {
    if (!privateKey) {
      throw new Error("PRIVATE_KEY is required for redeem helper");
    }
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.ctf = new ethers.Contract(CONDITIONAL_TOKENS, CTF_ABI, this.wallet);
  }

  get walletAddress(): string {
    return this.wallet.address;
  }

  async preview(
    conditionId: string,
    tokenIds: RedeemTokenIds,
    outcome?: string
  ): Promise<RedeemPreview> {
    const [yesNumerator, noNumerator, denominator, yesBalanceWei, noBalanceWei] = await Promise.all([
      this.ctf.payoutNumerators(conditionId, 0),
      this.ctf.payoutNumerators(conditionId, 1),
      this.ctf.payoutDenominator(conditionId),
      this.ctf.balanceOf(this.wallet.address, tokenIds.yesTokenId),
      this.ctf.balanceOf(this.wallet.address, tokenIds.noTokenId),
    ]);

    const resolved = denominator.gt(0);
    const detectedOutcome: RedeemOutcome | undefined = resolved
      ? yesNumerator.gt(0) && noNumerator.eq(0)
        ? "YES"
        : noNumerator.gt(0) && yesNumerator.eq(0)
          ? "NO"
          : undefined
      : undefined;
    const winningOutcome = normalizeOutcome(outcome) || detectedOutcome;
    const yesBalance = Number(ethers.utils.formatUnits(yesBalanceWei, 6));
    const noBalance = Number(ethers.utils.formatUnits(noBalanceWei, 6));
    const redeemableBalance =
      winningOutcome === "YES" ? yesBalance : winningOutcome === "NO" ? noBalance : 0;

    return {
      conditionId,
      resolved,
      winningOutcome,
      yesBalance,
      noBalance,
      redeemableBalance,
    };
  }

  async redeem(
    conditionId: string,
    tokenIds: RedeemTokenIds,
    outcome?: string
  ): Promise<RedeemExecution> {
    const preview = await this.preview(conditionId, tokenIds, outcome);
    if (!preview.resolved) {
      throw new Error(`Market ${conditionId} is not resolved`);
    }
    if (!preview.winningOutcome) {
      throw new Error(`Could not determine winning outcome for ${conditionId}`);
    }
    if (preview.redeemableBalance <= 0) {
      throw new Error(`No ${preview.winningOutcome} token balance to redeem`);
    }

    const indexSets = preview.winningOutcome === "YES" ? [1] : [2];
    const tx = await this.ctf.redeemPositions(
      POLYGON_USDCE,
      ethers.constants.HashZero,
      conditionId,
      indexSets
    );
    const receipt = await tx.wait();

    return {
      ...preview,
      txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed?.toString(),
    };
  }
}

export default RedeemHelper;
