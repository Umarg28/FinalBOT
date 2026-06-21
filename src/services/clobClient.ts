import { ethers } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { ENV } from "../config/env";
import logger from "../utils/logger";

let clobClient: ClobClient | null = null;
let clobApiCreds: ApiKeyCreds | null = null;

export async function createClobClient(): Promise<ClobClient> {
  if (clobClient) {
    return clobClient;
  }

  if (ENV.PAPER_MODE) {
    logger.paper("Running in paper mode - CLOB client will be limited");
    // Create a read-only client for paper mode (for market data)
    clobClient = new ClobClient(ENV.CLOB_HTTP_URL, 137);
    return clobClient;
  }

  try {
    const wallet = new ethers.Wallet(ENV.PRIVATE_KEY);

    clobClient = new ClobClient(
      ENV.CLOB_HTTP_URL,
      137, // Polygon chain ID
      wallet,
      undefined,
      1 // SignatureType.POLY_PROXY
    );

    // Try to create API key, fall back to derive if exists
    const originalConsoleError = console.error;
    console.error = () => {}; // Suppress expected errors

    try {
      clobApiCreds = await clobClient.deriveApiKey();
      logger.info("Using existing API credentials");
    } catch {
      clobApiCreds = await clobClient.createApiKey();
      logger.info("Created new API credentials");
    }

    console.error = originalConsoleError;

    if (clobApiCreds?.key) {
      clobClient = new ClobClient(
        ENV.CLOB_HTTP_URL,
        137,
        wallet,
        clobApiCreds,
        1
      );
    }

    logger.success("CLOB client initialized");
    return clobClient;
  } catch (error) {
    logger.error("Failed to create CLOB client:", error);
    throw error;
  }
}

export function getClobClient(): ClobClient | null {
  return clobClient;
}

export function getClobApiCreds(): ApiKeyCreds | null {
  return clobApiCreds;
}

export default createClobClient;
