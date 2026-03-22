"use client";

import { useChainContext } from "@/providers/ChainProvider";
import type { ChainType, ChainConfig } from "@holanc/sdk/adapters";

/**
 * Convenience hook exposing chain selection state.
 */
export function useChain() {
  const {
    activeChain,
    setActiveChain,
    chainConfig,
    solanaConfig,
    evmConfig,
    evmEnabled,
  } = useChainContext();

  return {
    activeChain,
    setActiveChain,
    chainConfig,
    solanaConfig,
    evmConfig,
    evmEnabled,
    isSolana: activeChain === "solana",
    isEvm: activeChain === "evm",
    /** Native currency symbol for the active chain. */
    nativeCurrency:
      chainConfig.nativeCurrency ?? (activeChain === "evm" ? "ETH" : "SOL"),
    /** Block explorer URL for the active chain. */
    explorerUrl: chainConfig.explorerUrl ?? "",
  };
}
