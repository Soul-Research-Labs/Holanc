"use client";

import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";

import "@solana/wallet-adapter-react-ui/styles.css";

import { ChainProvider } from "./ChainProvider";
import { EvmWalletProvider } from "./EvmWalletProvider";

const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";

/**
 * Multi-chain wallet provider.
 *
 * Wraps children in:
 *   1. ChainProvider  — chain selection state
 *   2. Solana wallet adapters (always mounted so hooks don't break)
 *   3. EVM wagmi + RainbowKit (always mounted for lazy wallet connect)
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ChainProvider>
      <ConnectionProvider endpoint={RPC_ENDPOINT}>
        <SolanaWalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <EvmWalletProvider>{children}</EvmWalletProvider>
          </WalletModalProvider>
        </SolanaWalletProvider>
      </ConnectionProvider>
    </ChainProvider>
  );
}
