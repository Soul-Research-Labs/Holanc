"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { HolancWallet, HolancProver } from "@holanc/sdk";

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

/**
 * Hook that wraps interaction with the Holanc SDK.
 * Uses HolancWallet for note management, HolancProver for proof generation,
 * and the Solana wallet adapter for transaction signing.
 */
export function useHolanc() {
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
        setError(e.message || "Deposit failed");
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
        setError(e.message || "Transfer failed");
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
        setError(e.message || "Withdrawal failed");
        setStatus("error");
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
    connected: !!publicKey,
    publicKey,
  };
}
