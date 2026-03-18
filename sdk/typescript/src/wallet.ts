import * as bip39 from "bip39";
import { Hash32, Note } from "./types";
import {
  poseidonHash,
  poseidonHashHex,
  hexToField,
  fieldToHex,
} from "./poseidon";
import { decryptNote, type EncryptedNote } from "./encryption";

export interface TxRecord {
  kind: "deposit" | "send" | "withdraw";
  amount: bigint;
  timestamp: number;
}

/** Serialized form of a Note (BigInt fields serialized as strings). */
interface NoteSnapshot {
  owner: string;
  value: string;
  assetId: string;
  blinding: string;
  commitment: string;
  nullifier: string;
  spent: boolean;
  pending: boolean;
  leafIndex: number | null;
}

/** Serialized form of a TxRecord. */
interface TxRecordSnapshot {
  kind: string;
  amount: string;
  timestamp: number;
}

/** Wallet persistence format (version-tagged for forward compatibility). */
interface WalletSnapshot {
  version: 1;
  spendingKey: string;
  nextBlinding: number;
  lastSyncedLeaf: number;
  notes: NoteSnapshot[];
  txHistory: TxRecordSnapshot[];
}

/**
 * HolancWallet — off-chain key management and note tracking.
 *
 * Manages spending/viewing keys derived from a BIP-39 mnemonic,
 * maintains the local note set, and provides coin selection.
 */
export class HolancWallet {
  private spendingKey: Uint8Array;
  private viewingKey: Hash32;
  private notes: Note[];
  private txHistory: TxRecord[];
  private nextBlinding: number;

  private constructor(spendingKey: Uint8Array) {
    this.spendingKey = spendingKey;
    this.viewingKey = "0".repeat(64); // Initialized async via initViewingKey()
    this.notes = [];
    this.txHistory = [];
    this.nextBlinding = 0;
  }

  /** Initialize the viewing key (must be called after construction). */
  private async initViewingKey(): Promise<void> {
    this.viewingKey = await poseidonHashHex([
      hexToField(this.spendingKeyHex()),
    ]);
  }

  /** Create wallet from BIP-39 mnemonic. */
  static async fromMnemonic(mnemonic: string): Promise<HolancWallet> {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error("Invalid mnemonic");
    }
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const wallet = new HolancWallet(seed.slice(0, 32));
    await wallet.initViewingKey();
    return wallet;
  }

  /** Create wallet with a random mnemonic. Returns [wallet, mnemonic]. */
  static async generate(): Promise<[HolancWallet, string]> {
    const mnemonic = bip39.generateMnemonic(128); // 12 words
    return [await HolancWallet.fromMnemonic(mnemonic), mnemonic];
  }

  /** Create wallet from a raw 32-byte spending key. */
  static async fromKey(key: Uint8Array): Promise<HolancWallet> {
    if (key.length !== 32) throw new Error("Spending key must be 32 bytes");
    const wallet = new HolancWallet(key);
    await wallet.initViewingKey();
    return wallet;
  }

  /** Create wallet with random key (no mnemonic backup). */
  static async random(): Promise<HolancWallet> {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const wallet = new HolancWallet(key);
    await wallet.initViewingKey();
    return wallet;
  }

  /** Hex-encoded spending key (for proof generation). */
  spendingKeyHex(): Hash32 {
    return Buffer.from(this.spendingKey).toString("hex");
  }

  /** Total unspent balance. */
  balance(): bigint {
    return this.notes
      .filter((n) => !n.spent)
      .reduce((sum, n) => sum + n.value, 0n);
  }

  /** Get unspent notes (excludes spent and pending-locked notes). */
  unspentNotes(): Note[] {
    return this.notes.filter((n) => !n.spent && !n.pending);
  }

  /** Transaction history. */
  history(): TxRecord[] {
    return [...this.txHistory];
  }

  /** Create a new deposit note for the given amount. */
  async createDepositNote(amount: bigint): Promise<Note> {
    const blinding = await this.deriveBlinding();
    const note: Note = {
      owner: this.spendingKeyHex(),
      value: amount,
      assetId: "0".repeat(64), // SOL default
      blinding,
      commitment: "",
      nullifier: "",
      spent: false,
    };
    note.commitment = await this.computeCommitment(note);
    note.nullifier = await this.computeNullifier(note);
    this.notes.push(note);
    this.txHistory.push({
      kind: "deposit",
      amount,
      timestamp: Date.now(),
    });
    return note;
  }

  /** Compute note commitment: Poseidon(owner, value, asset_id, blinding). */
  async computeCommitment(note: Note): Promise<Hash32> {
    return poseidonHashHex([
      hexToField(note.owner),
      note.value,
      hexToField(note.assetId),
      hexToField(note.blinding),
    ]);
  }

  /** Compute nullifier: Poseidon(spending_key, commitment). */
  private async computeNullifier(note: Note): Promise<Hash32> {
    return poseidonHashHex([
      hexToField(this.spendingKeyHex()),
      hexToField(note.commitment),
    ]);
  }

  /**
   * Select notes covering an amount.
   *
   * Uses randomized selection among qualifying candidates to prevent
   * fingerprinting via deterministic UTXO selection patterns.
   */
  selectNotes(amount: bigint): Note[] {
    const unspent = this.unspentNotes();

    // Collect all single-note candidates
    const singles = unspent.filter((n) => n.value >= amount);
    if (singles.length > 0) {
      return [singles[cryptoRandomIndex(singles.length)]];
    }

    // Collect all valid pairs
    const pairs: [Note, Note][] = [];
    for (let i = 0; i < unspent.length; i++) {
      for (let j = i + 1; j < unspent.length; j++) {
        if (unspent[i].value + unspent[j].value >= amount) {
          pairs.push([unspent[i], unspent[j]]);
        }
      }
    }
    if (pairs.length > 0) {
      const [a, b] = pairs[cryptoRandomIndex(pairs.length)];
      return [a, b];
    }

    throw new Error(
      `Insufficient balance: need ${amount}, have ${this.balance()}`,
    );
  }

  /** Prepare notes for a transfer. Returns input + output note sets. */
  async prepareTransfer(
    recipientOwner: Hash32,
    amount: bigint,
    fee: bigint,
  ): Promise<{ inputNotes: Note[]; outputNotes: Note[] }> {
    const total = amount + fee;
    const inputNotes = this.selectNotes(total);

    // Lock selected notes to prevent concurrent use in another transaction
    for (const n of inputNotes) n.pending = true;

    const inputSum = inputNotes.reduce((s, n) => s + n.value, 0n);
    const change = inputSum - total;

    const outputNotes: Note[] = [
      {
        owner: recipientOwner,
        value: amount,
        assetId: inputNotes[0].assetId,
        blinding: await this.deriveBlinding(),
        commitment: "",
        nullifier: "",
        spent: false,
      },
    ];

    if (change > 0n) {
      outputNotes.push({
        owner: this.spendingKeyHex(),
        value: change,
        assetId: inputNotes[0].assetId,
        blinding: await this.deriveBlinding(),
        commitment: "",
        nullifier: "",
        spent: false,
      });
    }

    this.txHistory.push({
      kind: "send",
      amount,
      timestamp: Date.now(),
    });

    return { inputNotes, outputNotes };
  }

  /** Prepare notes for a withdrawal. */
  async prepareWithdraw(
    amount: bigint,
    fee: bigint,
  ): Promise<{ inputNotes: Note[]; outputNotes: Note[] }> {
    const total = amount + fee;
    const inputNotes = this.selectNotes(total);

    // Lock selected notes to prevent concurrent use
    for (const n of inputNotes) n.pending = true;

    const inputSum = inputNotes.reduce((s, n) => s + n.value, 0n);
    const change = inputSum - total;

    const outputNotes: Note[] = [];
    if (change > 0n) {
      outputNotes.push({
        owner: this.spendingKeyHex(),
        value: change,
        assetId: inputNotes[0].assetId,
        blinding: await this.deriveBlinding(),
        commitment: "",
        nullifier: "",
        spent: false,
      });
    }

    this.txHistory.push({
      kind: "withdraw",
      amount,
      timestamp: Date.now(),
    });

    return { inputNotes, outputNotes };
  }

  /** Mark notes as spent and clear pending lock. */
  markSpent(notes: Note[]): void {
    const commitments = new Set(notes.map((n) => n.commitment));
    for (const note of this.notes) {
      if (commitments.has(note.commitment)) {
        note.spent = true;
        note.pending = false;
      }
    }
  }

  /** Unlock pending notes (e.g. after a failed transaction). */
  unlockNotes(notes: Note[]): void {
    const commitments = new Set(notes.map((n) => n.commitment));
    for (const note of this.notes) {
      if (commitments.has(note.commitment)) {
        note.pending = false;
      }
    }
  }

  private async deriveBlinding(): Promise<Hash32> {
    const idx = this.nextBlinding++;
    return poseidonHashHex([hexToField(this.spendingKeyHex()), BigInt(idx)]);
  }

  // -------------------------------------------------------------------------
  // Indexer sync — fetch & decrypt incoming notes
  // -------------------------------------------------------------------------

  /** Last leaf index that was synced from the indexer. */
  private lastSyncedLeaf = -1;

  /**
   * Fetch encrypted notes from the indexer, trial-decrypt each, and
   * merge any successfully decrypted notes into the local note set.
   *
   * @param indexerUrl  Base URL of the indexer HTTP server (e.g. "http://localhost:3002").
   * @returns Number of new notes discovered.
   */
  async fetchIncomingNotes(indexerUrl: string): Promise<number> {
    const limit = 500;
    const url = new URL(
      `/notes?after=${this.lastSyncedLeaf}&limit=${limit}`,
      indexerUrl,
    );

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Indexer returned ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as {
      notes: Array<{
        commitment: string;
        leafIndex: number;
        encryptedNote: string;
      }>;
    };

    if (!body.notes || body.notes.length === 0) return 0;

    const existingCommitments = new Set(this.notes.map((n) => n.commitment));
    let discovered = 0;

    for (const indexed of body.notes) {
      // Advance watermark regardless of decryption success
      if (indexed.leafIndex > this.lastSyncedLeaf) {
        this.lastSyncedLeaf = indexed.leafIndex;
      }

      // Skip notes we already have
      if (existingCommitments.has(indexed.commitment)) continue;

      // Parse the encrypted note bundle from hex
      const cipherBytes = Uint8Array.from(
        Buffer.from(indexed.encryptedNote, "hex"),
      );

      // The on-chain format is: ephemeral_pubkey_x (32) || ephemeral_pubkey_y (32) || ciphertext
      if (cipherBytes.length < 65) continue; // too short to contain a valid note

      const ephX = Buffer.from(cipherBytes.slice(0, 32))
        .toString("hex")
        .padStart(64, "0");
      const ephY = Buffer.from(cipherBytes.slice(32, 64))
        .toString("hex")
        .padStart(64, "0");
      const ct = cipherBytes.slice(64);

      const enc: EncryptedNote = {
        ephemeralPubKey: [ephX, ephY],
        ciphertext: ct,
      };

      const pt = await decryptNote(enc, this.spendingKeyHex());
      if (!pt) continue; // not addressed to us

      const note: Note = {
        owner: this.spendingKeyHex(),
        value: pt.value,
        assetId: pt.assetId,
        blinding: pt.blinding,
        commitment: "",
        nullifier: "",
        leafIndex: indexed.leafIndex,
        spent: false,
      };
      note.commitment = await this.computeCommitment(note);
      note.nullifier = await this.computeNullifier(note);

      this.notes.push(note);
      existingCommitments.add(note.commitment);
      discovered++;
    }

    return discovered;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Serialize the wallet to a JSON file.
   *
   * The spending key is stored as a hex string. Keep the wallet file secure —
   * it grants full control over all shielded notes.
   *
   * @param filePath - Absolute or relative path to the output file.
   */
  save(filePath: string): void {
    const fs: typeof import("fs") = require("fs");
    const data: WalletSnapshot = {
      version: 1,
      spendingKey: Buffer.from(this.spendingKey).toString("hex"),
      nextBlinding: this.nextBlinding,
      lastSyncedLeaf: this.lastSyncedLeaf,
      notes: this.notes.map((n) => ({
        owner: n.owner,
        value: n.value.toString(),
        assetId: n.assetId,
        blinding: n.blinding,
        commitment: n.commitment,
        nullifier: n.nullifier,
        spent: n.spent,
        pending: n.pending ?? false,
        leafIndex: n.leafIndex ?? null,
      })),
      txHistory: this.txHistory.map((r) => ({
        kind: r.kind,
        amount: r.amount.toString(),
        timestamp: r.timestamp,
      })),
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Restore a wallet from a previously saved JSON file.
   *
   * @param filePath - Path to the wallet JSON file created by `save()`.
   */
  static async load(filePath: string): Promise<HolancWallet> {
    const fs: typeof import("fs") = require("fs");
    const raw = fs.readFileSync(filePath, "utf-8");
    const data: WalletSnapshot = JSON.parse(raw);

    if (data.version !== 1) {
      throw new Error(
        `Unsupported wallet snapshot version ${data.version}. Expected 1.`,
      );
    }

    const spendingKey = Buffer.from(data.spendingKey, "hex");
    const wallet = new HolancWallet(spendingKey);
    await wallet.initViewingKey();

    wallet.nextBlinding = data.nextBlinding;
    wallet.lastSyncedLeaf = data.lastSyncedLeaf ?? -1;
    wallet.notes = data.notes.map((n) => ({
      owner: n.owner,
      value: BigInt(n.value),
      assetId: n.assetId,
      blinding: n.blinding,
      commitment: n.commitment,
      nullifier: n.nullifier,
      spent: n.spent,
      pending: n.pending,
      leafIndex: n.leafIndex ?? undefined,
    }));
    wallet.txHistory = data.txHistory.map((r) => ({
      kind: r.kind as "deposit" | "send" | "withdraw",
      amount: BigInt(r.amount),
      timestamp: r.timestamp,
    }));

    return wallet;
  }
}

/** Cryptographically random index in [0, max). */
function cryptoRandomIndex(max: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}
