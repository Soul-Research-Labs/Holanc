/**
 * Adapter factory — creates an EvmAdapter from a ChainConfig + ethers Signer.
 *
 * The Solana adapter requires Anchor/Keypair dependencies and is constructed
 * directly via `SolanaAdapter.create()`.  This factory is a convenience for
 * EVM chains used by the frontend.
 */

import type { Signer } from "ethers";
import { ChainConfig } from "./types";
import { EvmAdapter, EvmAdapterConfig } from "./evm";

/**
 * Build an EvmAdapter from a {@link ChainConfig} and an ethers `Signer`.
 *
 * Throws if `config.chainType` is not `"evm"`.
 */
export async function createEvmAdapter(
  config: ChainConfig,
  signer: Signer,
): Promise<EvmAdapter> {
  if (config.chainType !== "evm") {
    throw new Error(
      `createEvmAdapter requires chainType "evm", got "${config.chainType}"`,
    );
  }

  const adapterConfig: EvmAdapterConfig = {
    rpcUrl: config.rpcUrl,
    poolAddress: config.poolAddress,
    verifierAddress: config.verifierAddress,
    nullifierAddress: config.nullifierAddress,
    signer,
  };

  return EvmAdapter.create(adapterConfig);
}
