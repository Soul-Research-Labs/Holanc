"use client";

import { Header } from "@/components/Header";
import { PageShell, AmountInput, ProofStatus } from "@/components/shared";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { useHolanc } from "@/hooks/useHolanc";

type StealthMode = "send" | "scan";

export default function StealthPage() {
  const { connected, publicKey } = useWallet();
  const holanc = useHolanc();
  const [mode, setMode] = useState<StealthMode>("send");
  const [metaAddress, setMetaAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const handleSend = async () => {
    if (!metaAddress.trim() || !amount) return;
    setResult(null);
    const sendResult = await holanc.stealthSendTo(
      metaAddress.trim(),
      parseFloat(amount),
    );
    if (sendResult) {
      setResult(
        `Stealth payment sent! Ephemeral pubkey: ${sendResult.ephemeralPubkey.slice(
          0,
          16,
        )}… Stealth owner: ${sendResult.stealthOwner.slice(0, 16)}…`,
      );
    }
  };

  const handleScan = async () => {
    setResult(null);
    const results = await holanc.stealthScanIncoming();
    if (results.length > 0) {
      setResult(`Found ${results.length} incoming stealth payment(s).`);
    } else {
      setResult(
        "Scan complete. No incoming stealth payments found for this wallet.",
      );
    }
  };

  const isBusy =
    holanc.status === "generating" ||
    holanc.status === "sending" ||
    holanc.status === "confirming";
  const proofStatus = isBusy
    ? ("generating" as const)
    : holanc.status === "done"
    ? ("done" as const)
    : holanc.status === "error"
    ? ("error" as const)
    : ("idle" as const);
  const proofMessage =
    holanc.status === "sending"
      ? "Sending transaction…"
      : holanc.status === "confirming"
      ? "Confirming…"
      : holanc.error || undefined;

  return (
    <>
      <Header />
      <PageShell
        title="Stealth Addresses"
        description="Send shielded tokens to one-time stealth addresses, or scan for incoming stealth payments."
      >
        <div className="flex gap-2">
          <button
            className={mode === "send" ? "btn-primary" : "btn-secondary"}
            onClick={() => {
              setMode("send");
              holanc.reset();
              setResult(null);
            }}
          >
            Send
          </button>
          <button
            className={mode === "scan" ? "btn-primary" : "btn-secondary"}
            onClick={() => {
              setMode("scan");
              holanc.reset();
              setResult(null);
            }}
          >
            Scan Incoming
          </button>
        </div>

        {mode === "send" && (
          <div className="card space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Recipient Stealth Meta-Address
              </label>
              <input
                className="input font-mono text-xs"
                placeholder="Stealth meta-address (spending key + viewing key)"
                value={metaAddress}
                onChange={(e) => setMetaAddress(e.target.value)}
              />
              <p className="mt-1 text-xs text-gray-500">
                The recipient publishes their stealth meta-address. A one-time
                address is derived for each payment.
              </p>
            </div>

            <AmountInput value={amount} onChange={setAmount} />
            <ProofStatus status={proofStatus} message={proofMessage} />

            <button
              className="btn-primary w-full"
              disabled={!connected || !metaAddress.trim() || !amount || isBusy}
              onClick={handleSend}
            >
              {isBusy
                ? "Generating Stealth Proof…"
                : "Send via Stealth Address"}
            </button>
          </div>
        )}

        {mode === "scan" && (
          <div className="card space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Scan the on-chain registry for ephemeral public keys. Your viewing
              key will be used locally to check for payments addressed to you.
            </p>

            {publicKey && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs font-mono dark:border-gray-700 dark:bg-gray-800">
                Scanning as: {publicKey.toBase58().slice(0, 16)}…
              </div>
            )}

            <ProofStatus status={proofStatus} message={proofMessage} />

            <button
              className="btn-primary w-full"
              disabled={!connected || isBusy}
              onClick={handleScan}
            >
              {isBusy ? "Scanning…" : "Scan for Payments"}
            </button>
          </div>
        )}

        {result && (
          <div className="rounded-lg border border-holanc-200 bg-holanc-50 p-4 text-sm dark:border-holanc-800 dark:bg-holanc-900/20">
            <p className="text-holanc-700 dark:text-holanc-300">{result}</p>
          </div>
        )}
      </PageShell>
    </>
  );
}
