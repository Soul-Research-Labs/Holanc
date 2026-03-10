"use client";

import { Header } from "@/components/Header";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";

const FEATURES = [
  {
    href: "/deposit",
    title: "Deposit",
    description: "Shield tokens into the privacy pool with a ZK commitment.",
    icon: "↓",
    color:
      "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  },
  {
    href: "/transfer",
    title: "Private Transfer",
    description: "Transfer shielded tokens without revealing sender or amount.",
    icon: "→",
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  },
  {
    href: "/withdraw",
    title: "Withdraw",
    description: "Unshield tokens back to any Solana address with a ZK proof.",
    icon: "↑",
    color:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  },
  {
    href: "/stealth",
    title: "Stealth Addresses",
    description: "Send to one-time stealth addresses for receiver privacy.",
    icon: "👤",
    color:
      "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  },
  {
    href: "/bridge",
    title: "Cross-Chain Bridge",
    description:
      "Bridge shielded assets across Solana, Eclipse, and Sonic SVMs.",
    icon: "🌉",
    color:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  },
  {
    href: "/compliance",
    title: "Compliance",
    description: "Selective disclosure and ZK wealth proofs for regulated use.",
    icon: "✓",
    color: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  },
];

export default function DashboardPage() {
  const { connected } = useWallet();

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-10">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            Private Transactions on{" "}
            <span className="text-holanc-600">Solana</span>
          </h1>
          <p className="mt-3 text-lg text-gray-500 dark:text-gray-400">
            Holanc uses Groth16 zero-knowledge proofs to enable fully private
            deposits, transfers, and withdrawals on Solana and multi-SVM chains.
          </p>
        </div>

        {!connected && (
          <div className="mt-8 rounded-xl border border-holanc-200 bg-holanc-50 p-6 text-center dark:border-holanc-800 dark:bg-holanc-900/20">
            <p className="text-sm text-holanc-700 dark:text-holanc-300">
              Connect your wallet to get started with private transactions.
            </p>
          </div>
        )}

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Link
              key={f.href}
              href={f.href}
              className="card group transition-shadow hover:shadow-md"
            >
              <div
                className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg text-lg ${f.color}`}
              >
                {f.icon}
              </div>
              <h3 className="font-semibold group-hover:text-holanc-600">
                {f.title}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {f.description}
              </p>
            </Link>
          ))}
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          <div className="card text-center">
            <div className="text-2xl font-bold text-holanc-600">9</div>
            <div className="mt-1 text-xs text-gray-500">ZK Circuits</div>
          </div>
          <div className="card text-center">
            <div className="text-2xl font-bold text-holanc-600">3</div>
            <div className="mt-1 text-xs text-gray-500">SVM Chains</div>
          </div>
          <div className="card text-center">
            <div className="text-2xl font-bold text-holanc-600">Groth16</div>
            <div className="mt-1 text-xs text-gray-500">Proof System</div>
          </div>
        </div>
      </main>
    </>
  );
}
