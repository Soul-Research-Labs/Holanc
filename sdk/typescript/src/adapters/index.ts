/**
 * @holanc/sdk adapters — chain-specific implementations of ChainAdapter.
 *
 * Usage:
 *   import { SolanaAdapter, EvmAdapter } from "@holanc/sdk/adapters";
 *   import type { ChainAdapter } from "@holanc/sdk/adapters";
 */

export type {
  ChainAdapter,
  AdapterConfig,
  AdapterPoolStatus,
  CommitmentEvent,
  DepositParams,
  TransferParams,
  WithdrawParams,
  AdapterFactory,
  ChainType,
  ChainConfig,
} from "./types";

export { SolanaAdapter } from "./solana";
export type { SolanaAdapterConfig } from "./solana";

export { EvmAdapter } from "./evm";
export type { EvmAdapterConfig } from "./evm";

export { createEvmAdapter } from "./factory";
