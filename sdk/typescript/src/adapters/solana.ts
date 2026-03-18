/**
 * SolanaAdapter — ChainAdapter implementation wrapping the existing HolancClient.
 *
 * Bridges the generic ChainAdapter interface to the Solana-specific HolancClient,
 * HolancWallet, and @solana/web3.js infrastructure.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ChainAdapter,
  AdapterConfig,
  DepositParams,
  TransferParams,
  WithdrawParams,
  AdapterPoolStatus,
  CommitmentEvent,
} from "./types";
import { DepositResult, TransferResult, WithdrawResult } from "../types";
import { HolancClient } from "../client";
import { HolancWallet } from "../wallet";
import { RpcEndpointConfig, FailoverConfig } from "../rpc";

export interface SolanaAdapterConfig extends AdapterConfig {
  /** Solana transaction fee payer keypair. */
  payer: Keypair;
  /** Optional existing wallet; a random one will be created if omitted. */
  wallet?: HolancWallet;
  /** Token mint address (Solana SPL token). */
  tokenMint: string;
  /** Optional secondary RPC endpoints for failover. */
  failoverEndpoints?: (string | RpcEndpointConfig)[];
  /** Failover behavior options. */
  failoverConfig?: FailoverConfig;
  /** Verification key PDA (must match the deployed verifier program). */
  verificationKey?: string;
  /** Nullifier manager PDA. */
  nullifierManager?: string;
  /** Nullifier page PDA. */
  nullifierPage?: string;
  /** Fee collector token account address. */
  feeCollector?: string;
}

export class SolanaAdapter implements ChainAdapter {
  readonly chainName = "solana";

  private client: HolancClient;
  private config: SolanaAdapterConfig;

  private constructor(client: HolancClient, config: SolanaAdapterConfig) {
    this.client = client;
    this.config = config;
  }

  /** Create a SolanaAdapter from configuration. */
  static async create(config: SolanaAdapterConfig): Promise<SolanaAdapter> {
    const client =
      config.failoverEndpoints && config.failoverEndpoints.length > 0
        ? await HolancClient.createWithFailover(
            [config.rpcUrl, ...config.failoverEndpoints],
            config.payer,
            config.failoverConfig,
            config.wallet,
          )
        : await HolancClient.create(config.rpcUrl, config.payer, config.wallet);

    return new SolanaAdapter(client, config);
  }

  // -------------------------------------------------------------------------
  // Pool operations
  // -------------------------------------------------------------------------

  async deposit(params: DepositParams): Promise<DepositResult> {
    const tokenMint = new PublicKey(
      params.tokenAddress || this.config.tokenMint,
    );
    return this.client.deposit(params.amount, tokenMint);
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    const tokenMint = new PublicKey(this.config.tokenMint);
    const feeCollector = this.config.feeCollector
      ? new PublicKey(this.config.feeCollector)
      : undefined;
    const verificationKey = this.config.verificationKey
      ? new PublicKey(this.config.verificationKey)
      : undefined;
    const nullifierManager = this.config.nullifierManager
      ? new PublicKey(this.config.nullifierManager)
      : undefined;
    const nullifierPage = this.config.nullifierPage
      ? new PublicKey(this.config.nullifierPage)
      : undefined;

    // Transfer on Solana uses destination owner hash derived from the first output commitment.
    // The recipient's owner hash is embedded in the outputCommitments[0].
    const recipientOwnerHash = params.outputCommitments[0];

    return this.client.transfer(
      recipientOwnerHash,
      // Amount is derived from the proof; pass 0n as the client resolves from notes.
      0n,
      tokenMint,
      params.fee,
      feeCollector,
      verificationKey,
      nullifierManager,
      nullifierPage,
    );
  }

  async withdraw(params: WithdrawParams): Promise<WithdrawResult> {
    const tokenMint = new PublicKey(this.config.tokenMint);
    const recipient = new PublicKey(params.recipientAddress);
    const feeCollector = this.config.feeCollector
      ? new PublicKey(this.config.feeCollector)
      : undefined;
    const verificationKey = this.config.verificationKey
      ? new PublicKey(this.config.verificationKey)
      : undefined;
    const nullifierManager = this.config.nullifierManager
      ? new PublicKey(this.config.nullifierManager)
      : undefined;
    const nullifierPage = this.config.nullifierPage
      ? new PublicKey(this.config.nullifierPage)
      : undefined;

    return this.client.withdraw(
      params.exitAmount,
      params.fee,
      tokenMint,
      recipient,
      feeCollector,
      verificationKey,
      nullifierManager,
      nullifierPage,
    );
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  async getPoolStatus(): Promise<AdapterPoolStatus> {
    const status = await this.client.getPoolStatus(
      new PublicKey(this.config.tokenMint),
    );
    return {
      poolAddress: status.poolAddress.toBase58(),
      tokenAddress: status.tokenMint.toBase58(),
      totalDeposited: status.totalDeposited,
      nextLeafIndex: status.nextLeafIndex,
      currentRoot: Buffer.from(status.currentRoot, "hex").toString("hex"),
      isPaused: status.isPaused,
      epoch: status.epoch,
    };
  }

  async isNullifierSpent(nullifier: string): Promise<boolean> {
    return this.client.isNullifierSpent(nullifier);
  }

  async getMerkleRoot(): Promise<string> {
    const status = await this.client.getPoolStatus(
      new PublicKey(this.config.tokenMint),
    );
    return status.currentRoot;
  }

  // -------------------------------------------------------------------------
  // Event scanning
  // -------------------------------------------------------------------------

  async getCommitments(
    fromBlock: number,
    toBlock: number,
  ): Promise<CommitmentEvent[]> {
    // Solana uses slot numbers rather than block numbers.
    // Delegate to the client's fetchIncomingNotes which decodes on-chain logs.
    const notes = await this.client.fetchIncomingNotes(fromBlock, toBlock);
    return notes.map((n) => ({
      leafIndex: n.leafIndex ?? 0,
      commitment: n.commitment,
      encryptedNote: new Uint8Array(), // encrypted note is decoded by the wallet
      txHash: "",
      blockNumber: n.leafIndex ?? 0,
    }));
  }

  /** Access the underlying HolancClient for Solana-specific operations. */
  get holancClient(): HolancClient {
    return this.client;
  }
}
