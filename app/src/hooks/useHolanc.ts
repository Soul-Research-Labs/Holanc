"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useState } from "react";

export type TxStatus =
  | "idle"
  | "generating"
  | "sending"
  | "confirming"
  | "done"
  | "error";

/**
 * Hook that wraps interaction with the Holanc SDK.
 * In production this would import from `holanc-sdk` and call the real prover.
 * For now it provides a typed interface + simulated flow for UI development.
 */
export function useHolanc() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setTxSignature(null);
    setNote(null);
  }, []);

  const deposit = useCallback(
    async (amountSol: number) => {
      if (!publicKey) throw new Error("Wallet not connected");
      reset();
      try {
        setStatus("generating");
        // TODO: const proof = await sdk.prover.proveDeposit({ amount, ... })
        // Simulate proof generation delay
        await new Promise((r) => setTimeout(r, 2000));

        setStatus("sending");
        // TODO: const tx = sdk.client.buildDepositTx(proof, ...)
        // TODO: const sig = await sendTransaction(tx, connection)
        await new Promise((r) => setTimeout(r, 1000));

        setStatus("confirming");
        await new Promise((r) => setTimeout(r, 1500));

        // Generate a mock note
        const mockNote = `holanc-note-1-${Date.now().toString(
          36,
        )}-${Math.random().toString(36).slice(2, 10)}`;
        setNote(mockNote);
        setTxSignature("simulated_" + Date.now().toString(36));
        setStatus("done");
      } catch (e: any) {
        setError(e.message || "Deposit failed");
        setStatus("error");
      }
    },
    [publicKey, reset],
  );

  const transfer = useCallback(
    async (noteSecret: string, recipientPubkey: string, amount: number) => {
      if (!publicKey) throw new Error("Wallet not connected");
      reset();
      try {
        setStatus("generating");
        await new Promise((r) => setTimeout(r, 3000));

        setStatus("sending");
        await new Promise((r) => setTimeout(r, 1000));

        setStatus("confirming");
        await new Promise((r) => setTimeout(r, 1500));

        const mockNote = `holanc-note-1-${Date.now().toString(
          36,
        )}-${Math.random().toString(36).slice(2, 10)}`;
        setNote(mockNote);
        setTxSignature("simulated_" + Date.now().toString(36));
        setStatus("done");
      } catch (e: any) {
        setError(e.message || "Transfer failed");
        setStatus("error");
      }
    },
    [publicKey, reset],
  );

  const withdraw = useCallback(
    async (noteSecret: string, recipientAddress: string, amount: number) => {
      if (!publicKey) throw new Error("Wallet not connected");
      reset();
      try {
        setStatus("generating");
        await new Promise((r) => setTimeout(r, 3000));

        setStatus("sending");
        await new Promise((r) => setTimeout(r, 1000));

        setStatus("confirming");
        await new Promise((r) => setTimeout(r, 1500));

        setTxSignature("simulated_" + Date.now().toString(36));
        setStatus("done");
      } catch (e: any) {
        setError(e.message || "Withdrawal failed");
        setStatus("error");
      }
    },
    [publicKey, reset],
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
