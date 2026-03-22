"use client";

/**
 * Unified useHolanc hook — delegates to the Solana or EVM implementation
 * based on the active chain selected in ChainProvider.
 */

import { useChain } from "./useChain";
import { useSolanaHolanc } from "./useSolanaHolanc";
import { useEvmHolanc } from "./useEvmHolanc";

export type { TxStatus } from "./useSolanaHolanc";

export function useHolanc() {
  const { isEvm } = useChain();
  const solana = useSolanaHolanc();
  const evm = useEvmHolanc();
  return isEvm ? evm : solana;
}
