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

export default function TransferPage() {
  const [noteSecret, setNoteSecret] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const { transfer, status, error, note, txSignature, connected, reset } =
    useHolanc();
  const { nativeCurrency, isSolana } = useChain();

  const handleTransfer = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return;
    if (!noteSecret.trim() || !recipient.trim()) return;
    await transfer(noteSecret, recipient, parsedAmount);
  };

  return (
    <>
      <Header />
      <PageShell
        title="Private Transfer"
        description="Transfer shielded tokens to another user without revealing sender, receiver, or amount on-chain."
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
              Recipient Public Key
            </label>
            <input
              className="input font-mono text-xs"
              placeholder={
                isSolana ? "Recipient Solana address" : "Recipient 0x address"
              }
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>

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

          {note && (
            <NoteDisplay
              note={note}
              label="Recipient's New Note (share privately)"
            />
          )}

          {txSignature && status === "done" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-900/20">
              <span className="font-medium text-green-700 dark:text-green-300">
                Transfer successful!
              </span>
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
            onClick={handleTransfer}
          >
            {status === "idle" || status === "done" || status === "error"
              ? "Generate Proof & Transfer"
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
