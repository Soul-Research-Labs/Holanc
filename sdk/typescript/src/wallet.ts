import * as bip39 from "bip39";
import { Hash32, Note } from "./types";
import {
  poseidonHash,
  poseidonHashHex,
  hexToField,
  fieldToHex,
} from "./poseidon";

interface TxRecord {
  kind: "deposit" | "send" | "withdraw";
  amount: bigint;
  timestamp: number;
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
}

/** Cryptographically random index in [0, max). */
function cryptoRandomIndex(max: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}
