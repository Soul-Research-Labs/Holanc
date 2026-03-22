"use client";

import { type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import {
  mainnet,
  sepolia,
  arbitrum,
  optimism,
  polygon,
  base,
} from "wagmi/chains";
import { RainbowKitProvider, getDefaultConfig } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "@rainbow-me/rainbowkit/styles.css";

// ---------------------------------------------------------------------------
// wagmi + RainbowKit config
// ---------------------------------------------------------------------------

const evmRpcUrl = process.env.NEXT_PUBLIC_EVM_RPC_URL || "";
const chainId = parseInt(process.env.NEXT_PUBLIC_EVM_CHAIN_ID || "1", 10);

// Pick the matching chain object or default to mainnet.
const allChains = [
  mainnet,
  sepolia,
  arbitrum,
  optimism,
  polygon,
  base,
] as const;
const targetChain = allChains.find((c) => c.id === chainId) ?? mainnet;

const config = getDefaultConfig({
  appName: "Holanc",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "holanc-dev",
  chains: [targetChain],
  transports: {
    [targetChain.id]: evmRpcUrl ? http(evmRpcUrl) : http(),
  },
  ssr: true,
});

const queryClient = new QueryClient();

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
