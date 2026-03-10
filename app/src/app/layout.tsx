import type { Metadata } from "next";
import { WalletProvider } from "@/providers/WalletProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Holanc — Private Transactions on Solana",
  description:
    "Zero-knowledge privacy protocol for Solana. Deposit, transfer, and withdraw privately using Groth16 proofs.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
