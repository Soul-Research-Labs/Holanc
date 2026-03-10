"use client";

import { Header } from "@/components/Header";
import { PageShell, ProofStatus } from "@/components/shared";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { useHolanc } from "@/hooks/useHolanc";

type ComplianceTab = "disclosure" | "wealth" | "oracle";

export default function CompliancePage() {
  const { connected, publicKey } = useWallet();
  const holanc = useHolanc();
  const [tab, setTab] = useState<ComplianceTab>("disclosure");
  const [result, setResult] = useState<string | null>(null);

  // Disclosure state
  const [noteSecret, setNoteSecret] = useState("");
  const [oracleAddress, setOracleAddress] = useState("");

  // Wealth proof state
  const [threshold, setThreshold] = useState("");

  const handleDisclose = async () => {
    if (!noteSecret.trim() || !oracleAddress.trim()) return;
    setResult(null);
    const sig = await holanc.discloseToOracle(
      noteSecret.trim(),
      oracleAddress.trim(),
    );
    if (sig) {
      setResult(`Viewing key disclosed to oracle. Tx: ${sig.slice(0, 16)}…`);
    }
  };

  const handleWealthProof = async () => {
    const t = parseFloat(threshold);
    if (isNaN(t) || t <= 0) return;
    setResult(null);
    const sig = await holanc.generateWealthProof(t);
    if (sig) {
      setResult(
        `ZK wealth proof generated! Proves shielded balance ≥ ${t} SOL without revealing exact amount. Tx: ${sig.slice(
          0,
          16,
        )}…`,
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

  const tabs: { key: ComplianceTab; label: string }[] = [
    { key: "disclosure", label: "Selective Disclosure" },
    { key: "wealth", label: "Wealth Proof" },
    { key: "oracle", label: "Oracle Status" },
  ];

  return (
    <>
      <Header />
      <PageShell
        title="Compliance"
        description="Regulatory compliance tools: selective disclosure to authorized oracles and ZK wealth proofs."
      >
        <div className="flex gap-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? "btn-primary" : "btn-secondary"}
              onClick={() => {
                setTab(t.key);
                holanc.reset();
                setResult(null);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "disclosure" && (
          <div className="card space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Disclose your viewing key to an authorized compliance oracle. This
              allows the oracle to view transaction details for a specific note
              without accessing your funds.
            </p>

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

            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Oracle Address
              </label>
              <input
                className="input font-mono text-xs"
                placeholder="Registered compliance oracle public key"
                value={oracleAddress}
                onChange={(e) => setOracleAddress(e.target.value)}
              />
            </div>

            <ProofStatus status={proofStatus} message={proofMessage} />

            <button
              className="btn-primary w-full"
              disabled={
                !connected ||
                !noteSecret.trim() ||
                !oracleAddress.trim() ||
                isBusy
              }
              onClick={handleDisclose}
            >
              {isBusy ? "Encrypting Disclosure…" : "Disclose to Oracle"}
            </button>
          </div>
        )}

        {tab === "wealth" && (
          <div className="card space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Generate a zero-knowledge proof that your shielded balance exceeds
              a threshold, without revealing the exact amount. The attestation
              is stored on-chain for verifiers.
            </p>

            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Minimum Threshold (SOL)
              </label>
              <input
                type="text"
                inputMode="decimal"
                className="input"
                placeholder="e.g. 100"
                value={threshold}
                onChange={(e) => {
                  if (/^\d*\.?\d*$/.test(e.target.value))
                    setThreshold(e.target.value);
                }}
              />
              <p className="mt-1 text-xs text-gray-500">
                Proves your total shielded balance ≥ this value.
              </p>
            </div>

            <ProofStatus status={proofStatus} message={proofMessage} />

            <button
              className="btn-primary w-full"
              disabled={
                !connected || !threshold || parseFloat(threshold) <= 0 || isBusy
              }
              onClick={handleWealthProof}
            >
              {isBusy ? "Generating Wealth Proof…" : "Generate Wealth Proof"}
            </button>
          </div>
        )}

        {tab === "oracle" && (
          <div className="card space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              View registered compliance oracles and their attestation history.
            </p>

            <div className="space-y-3">
              {[
                {
                  name: "Chainalysis Oracle",
                  status: "Active",
                  attestations: 142,
                },
                { name: "TRM Labs Oracle", status: "Active", attestations: 89 },
                { name: "Elliptic Oracle", status: "Pending", attestations: 0 },
              ].map((oracle) => (
                <div
                  key={oracle.name}
                  className="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-700"
                >
                  <div>
                    <div className="text-sm font-medium">{oracle.name}</div>
                    <div className="text-xs text-gray-500">
                      {oracle.attestations} attestations
                    </div>
                  </div>
                  <span
                    className={
                      oracle.status === "Active"
                        ? "badge-success"
                        : "badge-pending"
                    }
                  >
                    {oracle.status}
                  </span>
                </div>
              ))}
            </div>
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
