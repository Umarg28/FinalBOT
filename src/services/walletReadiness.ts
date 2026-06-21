import { ethers } from "ethers";
import { ENV } from "../config/env";
import logger from "../utils/logger";

export const POLYGON_USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const POLYGON_NATIVE_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
export const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
export const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const ERC1155_ABI = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

export interface ApprovalStatus {
  name: string;
  address: string;
  approved: boolean;
  allowance?: string;
}

export interface WalletReadiness {
  wallet: string;
  maticBalance: number;
  usdcEBalance: number;
  nativeUsdcBalance: number;
  erc20Allowances: ApprovalStatus[];
  erc1155Approvals: ApprovalStatus[];
  ready: boolean;
  issues: string[];
}

const ERC20_SPENDERS = [
  { name: "CTF Exchange", address: CTF_EXCHANGE },
  { name: "Neg Risk CTF Exchange", address: NEG_RISK_CTF_EXCHANGE },
  { name: "Neg Risk Adapter", address: NEG_RISK_ADAPTER },
  { name: "Conditional Tokens", address: CONDITIONAL_TOKENS },
];

const ERC1155_OPERATORS = [
  { name: "CTF Exchange", address: CTF_EXCHANGE },
  { name: "Neg Risk CTF Exchange", address: NEG_RISK_CTF_EXCHANGE },
  { name: "Neg Risk Adapter", address: NEG_RISK_ADAPTER },
];

export class WalletReadinessService {
  private readonly provider: ethers.providers.JsonRpcProvider;

  constructor(rpcUrl: string = ENV.RPC_URL) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  }

  async check(walletAddress: string): Promise<WalletReadiness> {
    const usdcE = new ethers.Contract(POLYGON_USDCE, ERC20_ABI, this.provider);
    const nativeUsdc = new ethers.Contract(POLYGON_NATIVE_USDC, ERC20_ABI, this.provider);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.provider);

    const [maticWei, usdcEWei, nativeUsdcWei] = await Promise.all([
      this.provider.getBalance(walletAddress),
      usdcE.balanceOf(walletAddress),
      nativeUsdc.balanceOf(walletAddress),
    ]);

    const maticBalance = Number(ethers.utils.formatEther(maticWei));
    const usdcEBalance = Number(ethers.utils.formatUnits(usdcEWei, 6));
    const nativeUsdcBalance = Number(ethers.utils.formatUnits(nativeUsdcWei, 6));

    const erc20Allowances: ApprovalStatus[] = [];
    for (const spender of ERC20_SPENDERS) {
      const allowance = await usdcE.allowance(walletAddress, spender.address);
      const allowanceNumber = Number(ethers.utils.formatUnits(allowance, 6));
      erc20Allowances.push({
        ...spender,
        approved: allowanceNumber > 1e12,
        allowance: allowanceNumber > 1e12 ? "unlimited" : allowanceNumber.toFixed(2),
      });
    }

    const erc1155Approvals: ApprovalStatus[] = [];
    for (const operator of ERC1155_OPERATORS) {
      const approved = await conditionalTokens.isApprovedForAll(walletAddress, operator.address);
      erc1155Approvals.push({ ...operator, approved });
    }

    const issues: string[] = [];
    if (maticBalance < ENV.MIN_MATIC_BALANCE) {
      issues.push(`MATIC balance ${maticBalance.toFixed(4)} is below ${ENV.MIN_MATIC_BALANCE}`);
    }
    if (usdcEBalance < ENV.MIN_USDCE_BALANCE) {
      const nativeHint = nativeUsdcBalance > 0 ? ` Native USDC detected: ${nativeUsdcBalance.toFixed(2)}.` : "";
      issues.push(`USDC.e balance ${usdcEBalance.toFixed(2)} is below ${ENV.MIN_USDCE_BALANCE}.${nativeHint}`);
    }

    if (ENV.REQUIRE_TRADING_APPROVALS) {
      for (const approval of [...erc20Allowances, ...erc1155Approvals]) {
        if (!approval.approved) {
          issues.push(`${approval.name} approval is missing`);
        }
      }
    }

    return {
      wallet: walletAddress,
      maticBalance,
      usdcEBalance,
      nativeUsdcBalance,
      erc20Allowances,
      erc1155Approvals,
      ready: issues.length === 0,
      issues,
    };
  }

  async logReadiness(walletAddress: string): Promise<WalletReadiness> {
    const readiness = await this.check(walletAddress);
    logger.info(
      `[WALLET] ${readiness.wallet} | MATIC=${readiness.maticBalance.toFixed(4)} | USDC.e=${readiness.usdcEBalance.toFixed(2)} | native USDC=${readiness.nativeUsdcBalance.toFixed(2)}`
    );

    if (readiness.issues.length > 0) {
      for (const issue of readiness.issues) {
        logger.warn(`[WALLET] Readiness issue: ${issue}`);
      }
    } else {
      logger.success("[WALLET] Live wallet readiness checks passed");
    }

    return readiness;
  }
}

export default WalletReadinessService;
