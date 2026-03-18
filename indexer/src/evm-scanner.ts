/**
 * EvmNoteScanner — listens for NewCommitment and DepositEvent events emitted
 * by the Holanc EVM pool contract and persists them in the same NoteStore used
 * by the Solana scanner.
 *
 * Uses ethers.js v6 via dynamic import so it remains optional — the indexer
 * process only requires ethers when EVM_RPC_URL / HOLANC_POOL_ADDRESS are set.
 */

import { NoteStore, IndexedNote } from "./store";

const POOL_ABI = [
  "event NewCommitment(bytes32 indexed commitment, uint64 indexed leafIndex, bytes encryptedNote)",
  "event DepositEvent(address indexed depositor, bytes32 indexed commitment, uint64 leafIndex, uint256 amount)",
];

/** Interval between poll attempts when websocket is unavailable. */
const POLL_INTERVAL_MS = parseInt(
  process.env.EVM_POLL_INTERVAL_MS || "4000",
  10,
);

/** Number of past blocks to scan on first start (catch-up window). */
const CATCHUP_BLOCKS = parseInt(process.env.EVM_CATCHUP_BLOCKS || "1000", 10);

export class EvmNoteScanner {
  private rpcUrl: string;
  private poolAddress: string;
  private store: NoteStore;
  private running = false;

  /** Last processed EVM block number, persisted in metadata for restart safety. */
  private lastBlock: bigint | null = null;

  constructor(rpcUrl: string, poolAddress: string, store: NoteStore) {
    if (!rpcUrl || !rpcUrl.startsWith("http")) {
      throw new Error(`EvmNoteScanner: invalid rpcUrl: ${rpcUrl}`);
    }
    // Validate address is 20-byte hex (0x-prefixed).
    if (!/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) {
      throw new Error(`EvmNoteScanner: invalid pool address: ${poolAddress}`);
    }
    this.rpcUrl = rpcUrl;
    this.poolAddress = poolAddress;
    this.store = store;
  }

  async start(): Promise<void> {
    this.running = true;

    const { JsonRpcProvider, Contract } = await import("ethers");
    const provider = new JsonRpcProvider(this.rpcUrl);
    const pool = new Contract(this.poolAddress, POOL_ABI, provider);

    // Resume from the last indexed EVM block or fall back to a catch-up window.
    const savedBlock = this.store.getLastEvmBlock();
    const currentBlock = await provider.getBlockNumber();

    this.lastBlock =
      savedBlock != null
        ? BigInt(savedBlock)
        : BigInt(Math.max(0, currentBlock - CATCHUP_BLOCKS));

    console.log(
      `[evm-scanner] watching pool ${this.poolAddress} from block ${this.lastBlock}`,
    );

    // Try to subscribe via WebSocket-compatible polling (ethers JsonRpcProvider
    // polls periodically — no additional web socket needed).
    pool.on(
      "NewCommitment",
      async (
        commitment: string,
        leafIndex: bigint,
        encryptedNote: string,
        event: Record<string, unknown>,
      ) => {
        const blockNumber = (event.log as { blockNumber: number } | undefined)
          ?.blockNumber;
        const transactionHash =
          (event.log as { transactionHash: string } | undefined)
            ?.transactionHash ?? "0x";
        await this._handleNewCommitment(
          commitment,
          Number(leafIndex),
          encryptedNote,
          transactionHash,
          blockNumber ?? 0,
        );
      },
    );

    pool.on(
      "DepositEvent",
      async (
        depositor: string,
        commitment: string,
        leafIndex: bigint,
        amount: bigint,
        event: Record<string, unknown>,
      ) => {
        void depositor;
        void amount; // used only for existing NewCommitment indexing
        const blockNumber = (event.log as { blockNumber: number } | undefined)
          ?.blockNumber;
        const transactionHash =
          (event.log as { transactionHash: string } | undefined)
            ?.transactionHash ?? "0x";
        await this._handleNewCommitment(
          commitment,
          Number(leafIndex),
          "",
          transactionHash,
          blockNumber ?? 0,
        );
      },
    );

    // Catch-up: scan historical blocks for any missed events.
    await this._catchUp(provider, pool, this.lastBlock, BigInt(currentBlock));

    // Keep alive — the pool.on listeners handle new events via ethers' built-in
    // polling.  We use a lightweight keepalive to detect provider disconnects.
    while (this.running) {
      await sleep(POLL_INTERVAL_MS);
      try {
        await provider.getBlockNumber(); // lightweight heartbeat
      } catch {
        console.warn("[evm-scanner] provider heartbeat failed — will retry");
      }
    }

    await pool.removeAllListeners();
  }

  stop(): void {
    this.running = false;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async _catchUp(
    provider: import("ethers").JsonRpcProvider,
    pool: import("ethers").Contract,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<void> {
    if (toBlock <= fromBlock) return;

    console.log(`[evm-scanner] catch-up scan blocks ${fromBlock}–${toBlock}`);

    // Chunk to avoid RPC response size limits (most nodes cap at ~2000 blocks).
    const CHUNK = 2000n;
    for (let start = fromBlock; start <= toBlock; start += CHUNK) {
      const end = start + CHUNK - 1n < toBlock ? start + CHUNK - 1n : toBlock;

      const filter = pool.filters["NewCommitment"]?.();
      if (!filter) continue;

      const events = await pool.queryFilter(filter, Number(start), Number(end));
      for (const ev of events) {
        if (!("args" in ev) || !ev.args) continue;
        const [commitment, leafIndex, encryptedNote] = ev.args as [
          string,
          bigint,
          string,
        ];
        await this._handleNewCommitment(
          commitment,
          Number(leafIndex),
          encryptedNote ?? "",
          ev.transactionHash,
          ev.blockNumber,
        );
      }
    }
  }

  private async _handleNewCommitment(
    commitment: string,
    leafIndex: number,
    encryptedNote: string,
    txHash: string,
    blockNumber: number,
  ): Promise<void> {
    // Strip 0x prefix from commitment for storage consistency.
    const commitmentHex = commitment.startsWith("0x")
      ? commitment.slice(2)
      : commitment;

    const note: IndexedNote = {
      commitment: commitmentHex,
      leafIndex,
      encryptedNote: encryptedNote.startsWith("0x")
        ? encryptedNote.slice(2)
        : encryptedNote,
      txSignature: txHash,
      slot: blockNumber, // EVM block number maps to Solana slot
      blockTime: Math.floor(Date.now() / 1000),
    };

    this.store.insertNote(note);
    this.store.setLastEvmBlock(blockNumber);

    console.log(
      `[evm-scanner] indexed commitment ${commitmentHex} leaf=${leafIndex} block=${blockNumber}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
