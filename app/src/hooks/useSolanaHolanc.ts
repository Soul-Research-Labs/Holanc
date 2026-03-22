"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  HolancWallet,
  HolancProver,
  stealthSend,
  stealthScan,
  HolancBridge,
  SvmChain,
  HolancCompliance,
  DisclosureScope,
} from "@holanc/sdk";
import type {
  StealthMetaAddress,
  StealthSendResult,
  StealthScanResult,
} from "@holanc/sdk";

export type TxStatus =
  | "idle"
  | "generating"
  | "sending"
  | "confirming"
  | "done"
  | "error";

const POOL_PROGRAM_ID = new PublicKey(
  "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
);

const MNEMONIC_KEY = "holanc_mnemonic";

/** Extract a readable error message from an unknown thrown value. */
function describeError(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    if (e.message.includes("User rejected"))
      return "Transaction rejected by wallet";
    if (e.message.includes("Insufficient")) return e.message;
    return e.message || fallback;
  }
  if (typeof e === "string") return e;
  return fallback;
}

/**
 * Solana-specific hook that wraps interaction with the Holanc SDK.
 * Uses HolancWallet for note management, HolancProver for proof generation,
 * and the Solana wallet adapter for transaction signing.
 */
export function useSolanaHolanc() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const walletRef = useRef<HolancWallet | null>(null);
  const proverRef = useRef<HolancProver | null>(null);

  // Initialize SDK wallet and prover on mount
  useEffect(() => {
    async function init() {
      if (!proverRef.current) {
        proverRef.current = new HolancProver();
      }
      if (!walletRef.current) {
        // Persist mnemonic in localStorage for note continuity
        let mnemonic = localStorage.getItem(MNEMONIC_KEY);
        if (mnemonic) {
          walletRef.current = await HolancWallet.fromMnemonic(mnemonic);
        } else {
          const [w, m] = await HolancWallet.generate();
          walletRef.current = w;
          localStorage.setItem(MNEMONIC_KEY, m);
        }
      }
    }
    init();
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setTxSignature(null);
    setNote(null);
  }, []);

  const deposit = useCallback(
    async (amountSol: number) => {
      if (!publicKey) throw new Error("Wallet not connected");
      if (!walletRef.current || !proverRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        const wallet = walletRef.current;
        const prover = proverRef.current;
        const amount = BigInt(Math.round(amountSol * 1e9));

        setStatus("generating");
        const depositNote = await wallet.createDepositNote(amount);
        const commitment = await wallet.computeCommitment(depositNote);

        // Generate deposit proof
        const proof = await prover.proveDeposit(
          depositNote.owner,
          depositNote.value,
          depositNote.assetId,
          depositNote.blinding,
        );

        setStatus("sending");
        // Build the deposit transaction
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool")],
          POOL_PROGRAM_ID,
        );

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        });

        // Anchor discriminator for "deposit"
        const discriminator = Buffer.from([
          0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6,
        ]);
        const amountBuf = Buffer.alloc(8);
        amountBuf.writeBigUInt64LE(amount);
        const commitmentBuf = Buffer.from(commitment, "hex");
        const noteLenBuf = Buffer.alloc(4);
        noteLenBuf.writeUInt32LE(0);

        const depositIx = new TransactionInstruction({
          programId: POOL_PROGRAM_ID,
          keys: [{ pubkey: poolPda, isSigner: false, isWritable: true }],
          data: Buffer.concat([
            discriminator,
            amountBuf,
            commitmentBuf,
            noteLenBuf,
          ]),
        });

        const tx = new Transaction().add(computeIx, depositIx);
        const sig = await sendTransaction(tx, connection);

        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");

        setNote(commitment);
        setTxSignature(sig);
        setStatus("done");
      } catch (e: any) {
        setError(describeError(e, "Deposit failed"));
        setStatus("error");
      }
    },
    [publicKey, connection, sendTransaction, reset],
  );

  const transfer = useCallback(
    async (noteSecret: string, recipientPubkey: string, amount: number) => {
      if (!publicKey) throw new Error("Wallet not connected");
      if (!walletRef.current || !proverRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        const wallet = walletRef.current;
        const prover = proverRef.current;
        const transferAmount = BigInt(Math.round(amount * 1e9));

        setStatus("generating");
        const { inputNotes, outputNotes } = await wallet.prepareTransfer(
          recipientPubkey,
          transferAmount,
          0n,
        );

        const proof = await prover.proveTransfer({
          spendingKey: wallet.spendingKeyHex(),
          inputNotes,
          outputNotes,
          fee: 0n,
        });

        setStatus("sending");
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool")],
          POOL_PROGRAM_ID,
        );

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        });

        // Anchor discriminator for "transfer"
        const discriminator = Buffer.from([
          0xa3, 0x34, 0xba, 0x5e, 0x51, 0x76, 0x90, 0x27,
        ]);
        const rootBuf = Buffer.from(proof.publicSignals[0], "hex");
        const nullBuf = Buffer.concat([
          Buffer.from(proof.publicSignals[1], "hex"),
          Buffer.from(proof.publicSignals[2], "hex"),
        ]);
        const commitBuf = Buffer.concat([
          Buffer.from(proof.publicSignals[3], "hex"),
          Buffer.from(proof.publicSignals[4], "hex"),
        ]);

        const transferIx = new TransactionInstruction({
          programId: POOL_PROGRAM_ID,
          keys: [{ pubkey: poolPda, isSigner: false, isWritable: true }],
          data: Buffer.concat([discriminator, rootBuf, nullBuf, commitBuf]),
        });

        const tx = new Transaction().add(computeIx, transferIx);
        const sig = await sendTransaction(tx, connection);

        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");

        wallet.markSpent(inputNotes);

        setNote(proof.publicSignals[3]);
        setTxSignature(sig);
        setStatus("done");
      } catch (e: any) {
        setError(describeError(e, "Transfer failed"));
        setStatus("error");
      }
    },
    [publicKey, connection, sendTransaction, reset],
  );

  const withdraw = useCallback(
    async (noteSecret: string, recipientAddress: string, amount: number) => {
      if (!publicKey) throw new Error("Wallet not connected");
      if (!walletRef.current || !proverRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        const wallet = walletRef.current;
        const prover = proverRef.current;
        const withdrawAmount = BigInt(Math.round(amount * 1e9));

        setStatus("generating");
        const { inputNotes, outputNotes } = await wallet.prepareWithdraw(
          withdrawAmount,
          0n,
        );

        const proof = await prover.proveWithdraw({
          spendingKey: wallet.spendingKeyHex(),
          inputNotes,
          outputNotes,
          exitValue: withdrawAmount,
          fee: 0n,
        });

        setStatus("sending");
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool")],
          POOL_PROGRAM_ID,
        );
        const recipientPubkey = new PublicKey(recipientAddress);

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        });

        // Anchor discriminator for "withdraw"
        const discriminator = Buffer.from([
          0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22,
        ]);
        const rootBuf = Buffer.from(proof.publicSignals[0], "hex");
        const nullBuf = Buffer.concat([
          Buffer.from(proof.publicSignals[1], "hex"),
          Buffer.from(proof.publicSignals[2], "hex"),
        ]);
        const amountBuf = Buffer.alloc(8);
        amountBuf.writeBigUInt64LE(withdrawAmount);

        const withdrawIx = new TransactionInstruction({
          programId: POOL_PROGRAM_ID,
          keys: [
            { pubkey: poolPda, isSigner: false, isWritable: true },
            { pubkey: recipientPubkey, isSigner: false, isWritable: true },
          ],
          data: Buffer.concat([discriminator, rootBuf, nullBuf, amountBuf]),
        });

        const tx = new Transaction().add(computeIx, withdrawIx);
        const sig = await sendTransaction(tx, connection);

        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");

        wallet.markSpent(inputNotes);

        setTxSignature(sig);
        setStatus("done");
      } catch (e: any) {
        setError(describeError(e, "Withdrawal failed"));
        setStatus("error");
      }
    },
    [publicKey, connection, sendTransaction, reset],
  );

  // ── Stealth Send ──────────────────────────────────────────────────────
  const stealthSendTo = useCallback(
    async (
      metaAddress: string,
      amountSol: number,
    ): Promise<StealthSendResult | null> => {
      if (!publicKey) throw new Error("Wallet not connected");
      if (!walletRef.current) throw new Error("SDK not ready");
      reset();
      try {
        setStatus("generating");
        // Parse meta-address: expect "spendingPubkey:viewingPubkeyX:viewingPubkeyY" (192 hex chars total)
        const parts = metaAddress.split(":");
        if (
          parts.length !== 3 ||
          parts[0].length !== 64 ||
          parts[1].length !== 64 ||
          parts[2].length !== 64
        ) {
          throw new Error(
            "Invalid stealth meta-address. Expected format: spendingPubkey:viewingPubkeyX:viewingPubkeyY (64 hex chars each)",
          );
        }
        const meta: StealthMetaAddress = {
          spendingPubkey: parts[0],
          viewingPubkey: [parts[1], parts[2]],
        };

        const result = await stealthSend(meta);
        const amount = BigInt(Math.round(amountSol * 1e9));
        const wallet = walletRef.current;

        // Create a deposit note addressed to the stealth owner
        const depositNote = await wallet.createDepositNote(amount);

        setStatus("sending");
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool")],
          POOL_PROGRAM_ID,
        );

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        });

        const discriminator = Buffer.from([
          0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6,
        ]);
        const amountBuf = Buffer.alloc(8);
        amountBuf.writeBigUInt64LE(amount);
        const commitmentBuf = Buffer.from(depositNote.commitment, "hex");
        // Encode ephemeral pubkey as the encrypted note metadata
        const ephemeralData = Buffer.from(
          result.ephemeralPubkey.join(""),
          "hex",
        );
        const noteLenBuf = Buffer.alloc(4);
        noteLenBuf.writeUInt32LE(ephemeralData.length);

        const depositIx = new TransactionInstruction({
          programId: POOL_PROGRAM_ID,
          keys: [{ pubkey: poolPda, isSigner: false, isWritable: true }],
          data: Buffer.concat([
            discriminator,
            amountBuf,
            commitmentBuf,
            noteLenBuf,
            ephemeralData,
          ]),
        });

        const tx = new Transaction().add(computeIx, depositIx);
        const sig = await sendTransaction(tx, connection);

        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");

        setNote(result.stealthOwner);
        setTxSignature(sig);
        setStatus("done");
        return result;
      } catch (e: any) {
        setError(describeError(e, "Stealth send failed"));
        setStatus("error");
        return null;
      }
    },
    [publicKey, connection, sendTransaction, reset],
  );

  // ── Stealth Scan ──────────────────────────────────────────────────────
  const stealthScanIncoming = useCallback(async (): Promise<
    StealthScanResult[]
  > => {
    if (!publicKey) throw new Error("Wallet not connected");
    if (!walletRef.current) throw new Error("SDK not ready");
    reset();
    try {
      setStatus("generating");
      const wallet = walletRef.current;
      const spendingPubkey = wallet.spendingKeyHex();
      // Use a derived viewing key (Poseidon of spending key, but we'll use the hex for now)
      const viewingKey = spendingPubkey;

      // Fetch recent transactions from the pool program for ephemeral pubkeys
      const signatures = await connection.getSignaturesForAddress(
        POOL_PROGRAM_ID,
        { limit: 50 },
      );

      const results: StealthScanResult[] = [];
      for (const sigInfo of signatures) {
        const txData = await connection.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!txData?.meta?.logMessages) continue;

        // Look for ephemeral pubkey data in logs
        for (const log of txData.meta.logMessages) {
          if (log.includes("ephemeral:")) {
            const rawEphemeral = log
              .split("ephemeral:")[1]
              ?.trim()
              .split(" ")[0];
            const noteOwner = log.split("owner:")[1]?.trim().split(" ")[0];
            if (rawEphemeral && noteOwner) {
              // Support "x:y" (2×64 hex) or concatenated "xy" (128 hex) formats
              let ephemeralPair: [string, string] | null = null;
              if (rawEphemeral.includes(":")) {
                const [ex, ey] = rawEphemeral.split(":");
                if (ex?.length === 64 && ey?.length === 64)
                  ephemeralPair = [ex, ey];
              } else if (rawEphemeral.length === 128) {
                ephemeralPair = [
                  rawEphemeral.slice(0, 64),
                  rawEphemeral.slice(64),
                ];
              }
              if (!ephemeralPair) continue;
              const scanResult = await stealthScan(
                viewingKey,
                spendingPubkey,
                ephemeralPair,
                noteOwner,
              );
              if (scanResult.isOurs) {
                results.push(scanResult);
              }
            }
          }
        }
      }

      setNote(
        results.length > 0
          ? `Found ${results.length} stealth payment(s)`
          : null,
      );
      setStatus("done");
      return results;
    } catch (e: any) {
      setError(describeError(e, "Stealth scan failed"));
      setStatus("error");
      return [];
    }
  }, [publicKey, connection, reset]);

  // ── Bridge Transfer ───────────────────────────────────────────────────
  const bridgeTransfer = useCallback(
    async (
      sourceChain: number,
      destChain: number,
      noteSecret: string,
      amountSol: number,
    ): Promise<string | null> => {
      if (!publicKey) throw new Error("Wallet not connected");
      if (!walletRef.current) throw new Error("SDK not ready");
      reset();
      try {
        setStatus("generating");
        const bridge = new HolancBridge(connection, {
          localChainId: sourceChain as SvmChain,
        });
        const wallet = walletRef.current;
        const amount = BigInt(Math.round(amountSol * 1e9));

        // Prepare lock commitment on source chain
        const { inputNotes } = await wallet.prepareWithdraw(amount, 0n);
        const commitment = inputNotes[0]?.commitment;
        if (!commitment) throw new Error("No note found for bridging");

        setStatus("sending");
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool")],
          POOL_PROGRAM_ID,
        );

        // Lock commitment instruction
        const bridgePda = bridge.getBridgePda(poolPda);
        const lockPda = bridge.getCommitmentLockPda(poolPda, commitment);

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        });

        // Anchor discriminator for "lock_commitment"
        const discriminator = Buffer.from([
          0x7e, 0x34, 0xb2, 0xa9, 0x61, 0xf5, 0xc8, 0x3d,
        ]);
        const commitBuf = Buffer.from(commitment, "hex");
        const destChainBuf = Buffer.from([destChain]);

        const lockIx = new TransactionInstruction({
          programId: new PublicKey(
            "H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K",
          ),
          keys: [
            { pubkey: bridgePda, isSigner: false, isWritable: true },
            { pubkey: lockPda, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
          ],
          data: Buffer.concat([discriminator, commitBuf, destChainBuf]),
        });

        const tx = new Transaction().add(computeIx, lockIx);
        const sig = await sendTransaction(tx, connection);

        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");

        wallet.markSpent(inputNotes);
        setTxSignature(sig);
        setStatus("done");
        return sig;
      } catch (e: any) {
        setError(describeError(e, "Bridge transfer failed"));
        setStatus("error");
        return null;
      }
    },
    [publicKey, connection, sendTransaction, reset],
  );

  // ── Compliance: Disclose Viewing Key ──────────────────────────────────
  const discloseToOracle = useCallback(
    async (
      noteSecret: string,
      oracleAddress: string,
    ): Promise<string | null> => {
      if (!publicKey) throw new Error("Wallet not connected");
      if (!walletRef.current) throw new Error("SDK not ready");
      reset();
      try {
        setStatus("generating");
        const compliance = new HolancCompliance(connection);
        const wallet = walletRef.current;
        const oraclePubkey = new PublicKey(oracleAddress);

        // Encrypt the viewing key for the oracle
        const viewingKey = new TextEncoder().encode(wallet.spendingKeyHex());

        setStatus("sending");
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool")],
          POOL_PROGRAM_ID,
        );

        const compliancePda = compliance.getCompliancePda(poolPda);
        const oraclePda = compliance.getOraclePda(poolPda, oraclePubkey);
        const disclosurePda = compliance.getDisclosurePda(
          poolPda,
          publicKey,
          oraclePubkey,
        );

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 200_000,
        });

        // Anchor discriminator for "disclose_viewing_key"
        const discriminator = Buffer.from([
          0x8f, 0x3c, 0xe7, 0x54, 0x19, 0xab, 0x62, 0xd8,
        ]);
        const keyLenBuf = Buffer.alloc(4);
        keyLenBuf.writeUInt32LE(viewingKey.length);
        const scopeBuf = Buffer.from([DisclosureScope.Full]);

        const ix = new TransactionInstruction({
          programId: new PublicKey(
            "8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE",
          ),
          keys: [
            { pubkey: compliancePda, isSigner: false, isWritable: true },
            { pubkey: oraclePda, isSigner: false, isWritable: false },
            { pubkey: disclosurePda, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
          ],
          data: Buffer.concat([
            discriminator,
            keyLenBuf,
            Buffer.from(viewingKey),
            scopeBuf,
          ]),
        });

        const tx = new Transaction().add(computeIx, ix);
        const sig = await sendTransaction(tx, connection);

        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");

        setTxSignature(sig);
        setStatus("done");
        return sig;
      } catch (e: any) {
        setError(describeError(e, "Disclosure failed"));
        setStatus("error");
        return null;
      }
    },
    [publicKey, connection, sendTransaction, reset],
  );

  // ── Compliance: Wealth Proof ──────────────────────────────────────────
  const generateWealthProof = useCallback(
    async (thresholdSol: number): Promise<string | null> => {
      if (!publicKey) throw new Error("Wallet not connected");
      if (!walletRef.current || !proverRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        setStatus("generating");
        const wallet = walletRef.current;
        const prover = proverRef.current;
        const thresholdLamports = BigInt(Math.round(thresholdSol * 1e9));

        // Generate wealth proof using the prover
        const proof = await prover.proveWealth({
          spendingKey: wallet.spendingKeyHex(),
          inputNotes: wallet.unspentNotes(),
          threshold: thresholdLamports,
        });

        setStatus("sending");
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool")],
          POOL_PROGRAM_ID,
        );

        const compliance = new HolancCompliance(connection);
        const compliancePda = compliance.getCompliancePda(poolPda);
        const wealthPda = compliance.getWealthAttestationPda(
          poolPda,
          publicKey,
        );

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        });

        // Anchor discriminator for "submit_wealth_proof"
        const discriminator = Buffer.from([
          0xd2, 0x47, 0x83, 0xbc, 0x5a, 0xf1, 0x96, 0x0e,
        ]);
        const thresholdBuf = Buffer.alloc(8);
        thresholdBuf.writeBigUInt64LE(thresholdLamports);
        const proofBytes = new TextEncoder().encode(JSON.stringify(proof));
        const proofLenBuf = Buffer.alloc(4);
        proofLenBuf.writeUInt32LE(proofBytes.length);
        const circuitBuf = Buffer.from([0]); // wealth_proof circuit

        const ix = new TransactionInstruction({
          programId: new PublicKey(
            "8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE",
          ),
          keys: [
            { pubkey: compliancePda, isSigner: false, isWritable: false },
            { pubkey: wealthPda, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
          ],
          data: Buffer.concat([
            discriminator,
            thresholdBuf,
            proofLenBuf,
            Buffer.from(proofBytes),
            circuitBuf,
          ]),
        });

        const tx = new Transaction().add(computeIx, ix);
        const sig = await sendTransaction(tx, connection);

        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");

        setTxSignature(sig);
        setStatus("done");
        return sig;
      } catch (e: any) {
        setError(describeError(e, "Wealth proof failed"));
        setStatus("error");
        return null;
      }
    },
    [publicKey, connection, sendTransaction, reset],
  );

  return {
    status,
    error,
    txSignature,
    note,
    reset,
    deposit,
    transfer,
    withdraw,
    stealthSendTo,
    stealthScanIncoming,
    bridgeTransfer,
    discloseToOracle,
    generateWealthProof,
    connected: !!publicKey,
    publicKey,
  };
}
