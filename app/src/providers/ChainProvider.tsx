"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ChainType, ChainConfig } from "@holanc/sdk/adapters";

// ---------------------------------------------------------------------------
// Environment-driven chain configurations
// ---------------------------------------------------------------------------

const SOLANA_CONFIG: ChainConfig = {
  chainType: "solana",
  chainName: "Solana",
  chainId: 0,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
  poolAddress:
    process.env.NEXT_PUBLIC_POOL_PROGRAM_ID ||
    "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
  tokenAddress: process.env.NEXT_PUBLIC_TOKEN_MINT || "",
  verifierAddress: process.env.NEXT_PUBLIC_VERIFIER_PROGRAM_ID,
  nullifierAddress: process.env.NEXT_PUBLIC_NULLIFIER_PROGRAM_ID,
  bridgeAddress: process.env.NEXT_PUBLIC_BRIDGE_PROGRAM_ID,
  complianceAddress: process.env.NEXT_PUBLIC_COMPLIANCE_PROGRAM_ID,
  explorerUrl: "https://explorer.solana.com",
  nativeCurrency: "SOL",
};

const EVM_CONFIG: ChainConfig = {
  chainType: "evm",
  chainName: process.env.NEXT_PUBLIC_EVM_CHAIN_NAME || "Ethereum",
  chainId: parseInt(process.env.NEXT_PUBLIC_EVM_CHAIN_ID || "1", 10),
  rpcUrl: process.env.NEXT_PUBLIC_EVM_RPC_URL || "",
  poolAddress: process.env.NEXT_PUBLIC_EVM_POOL_ADDRESS || "",
  tokenAddress: process.env.NEXT_PUBLIC_EVM_TOKEN_ADDRESS || "",
  verifierAddress: process.env.NEXT_PUBLIC_EVM_VERIFIER_ADDRESS,
  nullifierAddress: process.env.NEXT_PUBLIC_EVM_NULLIFIER_ADDRESS,
  bridgeAddress: process.env.NEXT_PUBLIC_EVM_BRIDGE_ADDRESS,
  complianceAddress: process.env.NEXT_PUBLIC_EVM_COMPLIANCE_ADDRESS,
  explorerUrl:
    process.env.NEXT_PUBLIC_EVM_EXPLORER_URL || "https://etherscan.io",
  nativeCurrency: process.env.NEXT_PUBLIC_EVM_NATIVE_CURRENCY || "ETH",
};

/** Whether EVM support is configured (pool address is set). */
export const EVM_ENABLED = !!EVM_CONFIG.poolAddress;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ChainContextValue {
  activeChain: ChainType;
  setActiveChain: (chain: ChainType) => void;
  chainConfig: ChainConfig;
  solanaConfig: ChainConfig;
  evmConfig: ChainConfig;
  evmEnabled: boolean;
}

const ChainContext = createContext<ChainContextValue | null>(null);

const STORAGE_KEY = "holanc_active_chain";

export function ChainProvider({ children }: { children: ReactNode }) {
  const [activeChain, setActiveChainRaw] = useState<ChainType>("solana");

  // Restore persisted chain on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ChainType | null;
    if (stored === "evm" && EVM_ENABLED) {
      setActiveChainRaw("evm");
    }
  }, []);

  const setActiveChain = useCallback((chain: ChainType) => {
    setActiveChainRaw(chain);
    localStorage.setItem(STORAGE_KEY, chain);
  }, []);

  const chainConfig = activeChain === "evm" ? EVM_CONFIG : SOLANA_CONFIG;

  return (
    <ChainContext.Provider
      value={{
        activeChain,
        setActiveChain,
        chainConfig,
        solanaConfig: SOLANA_CONFIG,
        evmConfig: EVM_CONFIG,
        evmEnabled: EVM_ENABLED,
      }}
    >
      {children}
    </ChainContext.Provider>
  );
}

export function useChainContext(): ChainContextValue {
  const ctx = useContext(ChainContext);
  if (!ctx) {
    throw new Error("useChainContext must be used within <ChainProvider>");
  }
  return ctx;
}
