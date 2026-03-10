"use client";

import { Header } from "@/components/Header";
import { PageShell, AmountInput, ProofStatus } from "@/components/shared";
import { useHolanc } from "@/hooks/useHolanc";
import { useState } from "react";

export default function WithdrawPage() {
  const [noteSecret, setNoteSecret] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const { withdraw, status, error, txSignature, connected, reset } =
    useHolanc();

  const handleWithdraw = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return;
    if (!noteSecret.trim() || !recipient.trim()) return;
    await withdraw(noteSecret, recipient, parsedAmount);
  };

  return (
    <>
      <Header />
      <PageShell
        title="Withdraw"
        description="Unshield tokens from the privacy pool back to any Solana address. Uses a ZK proof to break the on-chain link."
      >
        <div className="card space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Your Secret Note
            </label>
            <textarea
              className="input min-h-[72px] font-mono text-xs"
              placeholder="holanc-note-1-..."
              value={noteSecret}
              onChange={(e) => setNoteSecret(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Withdrawal Address
            </label>
            <input
              className="input font-mono text-xs"
              placeholder="Solana address to receive tokens"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>

          <AmountInput value={amount} onChange={setAmount} />

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

          {txSignature && status === "done" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-900/20">
              <span className="font-medium text-green-700 dark:text-green-300">
                Withdrawal successful!
              </span>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                Tokens sent to {recipient.slice(0, 8)}…{recipient.slice(-4)}
              </p>
            </div>
          )}

          <button
            className="btn-primary w-full"
            disabled={
              !connected ||
              !noteSecret.trim() ||
              !recipient.trim() ||
              !amount ||
              parseFloat(amount) <= 0 ||
              (status !== "idle" && status !== "done" && status !== "error")
            }
            onClick={handleWithdraw}
          >
            {status === "idle" || status === "done" || status === "error"
              ? `Withdraw ${amount || "0"} SOL`
              : "Processing…"}
          </button>

          {(status === "done" || status === "error") && (
            <button className="btn-secondary w-full" onClick={reset}>
              Reset
            </button>
          )}
        </div>
      </PageShell>
    </>
  );
}
