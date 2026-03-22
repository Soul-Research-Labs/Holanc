"use client";

import { Header } from "@/components/Header";
import {
  PageShell,
  AmountInput,
  ProofStatus,
  NoteDisplay,
} from "@/components/shared";
import { useHolanc } from "@/hooks/useHolanc";
import { useChain } from "@/hooks/useChain";
import { useState } from "react";

export default function DepositPage() {
  const [amount, setAmount] = useState("");
  const { deposit, status, error, note, txSignature, connected, reset } =
    useHolanc();
  const { nativeCurrency } = useChain();

  const handleDeposit = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return;
    await deposit(parsedAmount);
  };

  return (
    <>
      <Header />
      <PageShell
        title="Deposit"
        description="Shield tokens into the Holanc privacy pool. You'll receive a secret note to prove ownership."
      >
        <div className="card space-y-4">
          <AmountInput
            value={amount}
            onChange={setAmount}
            token={nativeCurrency}
          />

          <ProofStatus
            status={
              status === "generating"
                ? "generating"
                : status === "done"
                ? "done"
                : status === "error"
                ? "error"
                : "idle"
            }
            message={
              status === "sending"
                ? "Sending transaction…"
                : status === "confirming"
                ? "Waiting for confirmation…"
                : error || undefined
            }
          />

          {note && <NoteDisplay note={note} />}

          {txSignature && status === "done" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-900/20">
              <span className="font-medium text-green-700 dark:text-green-300">
                Deposit successful!
              </span>
              <p className="mt-1 break-all font-mono text-xs text-gray-600 dark:text-gray-400">
                Tx: {txSignature}
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              className="btn-primary flex-1"
              disabled={
                !connected ||
                !amount ||
                parseFloat(amount) <= 0 ||
                (status !== "idle" && status !== "done" && status !== "error")
              }
              onClick={handleDeposit}
            >
              {status === "idle" || status === "done" || status === "error"
                ? `Deposit ${amount || "0"} ${nativeCurrency}`
                : "Processing…"}
            </button>
            {(status === "done" || status === "error") && (
              <button className="btn-secondary" onClick={reset}>
                Reset
              </button>
            )}
          </div>

          {!connected && (
            <p className="text-center text-sm text-gray-500">
              Connect your wallet to make a deposit.
            </p>
          )}
        </div>
      </PageShell>
    </>
  );
}
