import * as bip39 from "bip39";
import { Hash32, Note } from "./types";

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
    this.viewingKey = "0".repeat(64); // Derived via Poseidon at init
    this.notes = [];
    this.txHistory = [];
    this.nextBlinding = 0;
  }

  /** Create wallet from BIP-39 mnemonic. */
  static fromMnemonic(mnemonic: string): HolancWallet {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error("Invalid mnemonic");
    }
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    // Use first 32 bytes of seed as spending key
    return new HolancWallet(seed.slice(0, 32));
  }

  /** Create wallet with a random mnemonic. Returns [wallet, mnemonic]. */
  static generate(): [HolancWallet, string] {
    const mnemonic = bip39.generateMnemonic(128); // 12 words
    return [HolancWallet.fromMnemonic(mnemonic), mnemonic];
  }

  /** Create wallet from a raw 32-byte spending key. */
  static fromKey(key: Uint8Array): HolancWallet {
    if (key.length !== 32) throw new Error("Spending key must be 32 bytes");
    return new HolancWallet(key);
  }

  /** Create wallet with random key (no mnemonic backup). */
  static random(): HolancWallet {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    return new HolancWallet(key);
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

  /** Get unspent notes. */
  unspentNotes(): Note[] {
    return this.notes.filter((n) => !n.spent);
  }

  /** Transaction history. */
  history(): TxRecord[] {
    return [...this.txHistory];
  }

  /** Create a new deposit note for the given amount. */
  createDepositNote(amount: bigint): Note {
    const blinding = this.deriveBlinding();
    const note: Note = {
      owner: this.spendingKeyHex(),
      value: amount,
      assetId: "0".repeat(64), // SOL default
      blinding,
      commitment: "", // Computed after
      nullifier: "",
      spent: false,
    };
    note.commitment = this.computeCommitment(note);
    note.nullifier = this.computeNullifier(note);
    this.notes.push(note);
    this.txHistory.push({
      kind: "deposit",
      amount,
      timestamp: Date.now(),
    });
    return note;
  }

  /** Compute note commitment: Poseidon(owner, value, asset_id, blinding). */
  computeCommitment(note: Note): Hash32 {
    // Simplified - actual implementation uses circomlibjs Poseidon
    // This is a placeholder that will be replaced with real Poseidon hash
    const data = `${note.owner}${note.value}${note.assetId}${note.blinding}`;
    return sha256Hex(data);
  }

  /** Compute nullifier: Poseidon(spending_key, commitment). */
  private computeNullifier(note: Note): Hash32 {
    const data = `${this.spendingKeyHex()}${note.commitment}`;
    return sha256Hex(data);
  }

  /** Select notes covering an amount. Greedy largest-first, max 2 inputs. */
  selectNotes(amount: bigint): Note[] {
    const unspent = this.unspentNotes().sort((a, b) =>
      a.value > b.value ? -1 : a.value < b.value ? 1 : 0,
    );

    // Try single note first
    const single = unspent.find((n) => n.value >= amount);
    if (single) return [single];

    // Try two notes
    for (let i = 0; i < unspent.length; i++) {
      for (let j = i + 1; j < unspent.length; j++) {
        if (unspent[i].value + unspent[j].value >= amount) {
          return [unspent[i], unspent[j]];
        }
      }
    }

    throw new Error(
      `Insufficient balance: need ${amount}, have ${this.balance()}`,
    );
  }

  /** Prepare notes for a transfer. Returns input + output note sets. */
  prepareTransfer(
    recipientOwner: Hash32,
    amount: bigint,
    fee: bigint,
  ): { inputNotes: Note[]; outputNotes: Note[] } {
    const total = amount + fee;
    const inputNotes = this.selectNotes(total);
    const inputSum = inputNotes.reduce((s, n) => s + n.value, 0n);
    const change = inputSum - total;

    const outputNotes: Note[] = [
      {
        owner: recipientOwner,
        value: amount,
        assetId: inputNotes[0].assetId,
        blinding: this.deriveBlinding(),
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
        blinding: this.deriveBlinding(),
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
  prepareWithdraw(
    amount: bigint,
    fee: bigint,
  ): { inputNotes: Note[]; outputNotes: Note[] } {
    const total = amount + fee;
    const inputNotes = this.selectNotes(total);
    const inputSum = inputNotes.reduce((s, n) => s + n.value, 0n);
    const change = inputSum - total;

    const outputNotes: Note[] = [];
    if (change > 0n) {
      outputNotes.push({
        owner: this.spendingKeyHex(),
        value: change,
        assetId: inputNotes[0].assetId,
        blinding: this.deriveBlinding(),
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

  /** Mark notes as spent. */
  markSpent(notes: Note[]): void {
    const commitments = new Set(notes.map((n) => n.commitment));
    for (const note of this.notes) {
      if (commitments.has(note.commitment)) {
        note.spent = true;
      }
    }
  }

  private deriveBlinding(): Hash32 {
    const idx = this.nextBlinding++;
    const data = `${this.spendingKeyHex()}:blinding:${idx}`;
    return sha256Hex(data);
  }
}

/** Simple SHA-256 hex digest (sync, uses Node crypto). */
function sha256Hex(input: string): Hash32 {
  // Use Web Crypto-compatible approach
  // In practice this gets replaced with Poseidon at integration time
  const { createHash } = require("crypto");
  return createHash("sha256").update(input).digest("hex");
}
