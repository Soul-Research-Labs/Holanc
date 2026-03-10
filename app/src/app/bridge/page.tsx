"use client";

import { Header } from "@/components/Header";
import { PageShell, AmountInput, ProofStatus } from "@/components/shared";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { useHolanc } from "@/hooks/useHolanc";

const CHAINS = [
  { id: 1, name: "Solana", icon: "◎" },
  { id: 2, name: "Eclipse", icon: "🌑" },
  { id: 3, name: "Sonic", icon: "⚡" },
];

export default function BridgePage() {
  const { connected } = useWallet();
  const holanc = useHolanc();
  const [sourceChain, setSourceChain] = useState(1);
  const [destChain, setDestChain] = useState(2);
  const [amount, setAmount] = useState("");
  const [noteSecret, setNoteSecret] = useState("");

  const handleBridge = async () => {
    if (!noteSecret.trim() || !amount) return;
    await holanc.bridgeTransfer(
      sourceChain,
      destChain,
      noteSecret.trim(),
      parseFloat(amount),
    );
  };

  const isBusy =
    holanc.status === "generating" ||
    holanc.status === "sending" ||
    holanc.status === "confirming";

  return (
    <>
      <Header />
      <PageShell
        title="Cross-Chain Bridge"
        description="Bridge shielded assets between Solana Virtual Machine (SVM) chains while preserving privacy."
      >
        <div className="card space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Source Chain
              </label>
              <select
                className="input"
                value={sourceChain}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSourceChain(v);
                  if (v === destChain)
                    setDestChain(CHAINS.find((c) => c.id !== v)!.id);
                }}
              >
                {CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Destination Chain
              </label>
              <select
                className="input"
                value={destChain}
                onChange={(e) => setDestChain(Number(e.target.value))}
              >
                {CHAINS.filter((c) => c.id !== sourceChain).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Secret Note
            </label>
            <textarea
              className="input min-h-[72px] font-mono text-xs"
              placeholder="holanc-note-1-..."
              value={noteSecret}
              onChange={(e) => setNoteSecret(e.target.value)}
            />
          </div>

          <AmountInput value={amount} onChange={setAmount} />

          <ProofStatus
            status={
              isBusy
                ? "generating"
                : holanc.status === "done"
                ? "done"
                : holanc.status === "error"
                ? "error"
                : "idle"
            }
            message={isBusy ? "Processing bridge transfer…" : undefined}
          />

          {holanc.status === "done" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-900/20">
              <span className="font-medium text-green-700 dark:text-green-300">
                Bridge transfer complete!
              </span>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {CHAINS.find((c) => c.id === sourceChain)?.name} →{" "}
                {CHAINS.find((c) => c.id === destChain)?.name} — shielded
                commitment created on destination.
              </p>
            </div>
          )}

          <button
            className="btn-primary w-full"
            disabled={!connected || !noteSecret.trim() || !amount || isBusy}
            onClick={handleBridge}
          >
            {isBusy
              ? "Bridging…"
              : `Bridge to ${CHAINS.find((c) => c.id === destChain)?.name}`}
          </button>

          {holanc.status === "done" && (
            <button
              className="btn-secondary w-full"
              onClick={() => {
                holanc.reset();
              }}
            >
              New Bridge Transfer
            </button>
          )}
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold">How it works</h3>
          <ol className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-400">
            <li>
              1. Your commitment is locked on the source chain with a ZK proof.
            </li>
            <li>2. A Wormhole VAA attests the lock across chains.</li>
            <li>
              3. The commitment is minted on the destination chain's privacy
              pool.
            </li>
            <li>4. You receive a new secret note for the destination chain.</li>
          </ol>
        </div>
      </PageShell>
    </>
  );
}
