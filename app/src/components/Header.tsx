"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useChain } from "@/hooks/useChain";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "⌂" },
  { href: "/deposit", label: "Deposit", icon: "↓" },
  { href: "/transfer", label: "Transfer", icon: "→" },
  { href: "/withdraw", label: "Withdraw", icon: "↑" },
  { href: "/stealth", label: "Stealth", icon: "👤" },
  { href: "/bridge", label: "Bridge", icon: "🌉" },
  { href: "/compliance", label: "Compliance", icon: "✓" },
];

export function Header() {
  const pathname = usePathname();
  const { connected: solanaConnected } = useWallet();
  const { isConnected: evmConnected } = useAccount();
  const { activeChain, setActiveChain, evmEnabled, isSolana, isEvm } =
    useChain();

  const connected = isSolana ? solanaConnected : evmConnected;

  return (
    <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur-md dark:border-gray-800 dark:bg-gray-950/80">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-holanc-600 text-sm font-bold text-white">
              H
            </div>
            <span className="text-lg font-semibold">Holanc</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  pathname === item.href
                    ? "bg-holanc-50 text-holanc-700 dark:bg-holanc-900/30 dark:text-holanc-300"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                }`}
              >
                <span className="mr-1">{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {/* Chain selector */}
          {evmEnabled && (
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700">
              <button
                className={`px-3 py-1.5 text-xs font-medium transition-colors first:rounded-l-lg ${
                  isSolana
                    ? "bg-holanc-600 text-white"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400"
                }`}
                onClick={() => setActiveChain("solana")}
              >
                ◎ Solana
              </button>
              <button
                className={`px-3 py-1.5 text-xs font-medium transition-colors last:rounded-r-lg ${
                  isEvm
                    ? "bg-holanc-600 text-white"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400"
                }`}
                onClick={() => setActiveChain("evm")}
              >
                ⟠ Ethereum
              </button>
            </div>
          )}

          {connected && (
            <span className="badge-success text-xs">Connected</span>
          )}

          {/* Wallet button — show the appropriate one for the active chain */}
          {isSolana ? (
            <WalletMultiButton />
          ) : (
            <ConnectButton
              showBalance={false}
              chainStatus="icon"
              accountStatus="address"
            />
          )}
        </div>
      </div>
    </header>
  );
}
