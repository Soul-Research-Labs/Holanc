"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { BrowserProvider } from "ethers";
import { HolancWallet, HolancProver } from "@holanc/sdk";
import { EvmAdapter } from "@holanc/sdk/adapters";
import { useChainContext } from "@/providers/ChainProvider";
import type { TxStatus } from "./useSolanaHolanc";

import type {
  StealthMetaAddress,
  StealthSendResult,
  StealthScanResult,
} from "@holanc/sdk";
import { stealthSend, stealthScan } from "@holanc/sdk";

const MNEMONIC_KEY = "holanc_mnemonic";

function describeError(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    if (
      e.message.includes("User rejected") ||
      e.message.includes("user rejected")
    )
      return "Transaction rejected by wallet";
    if (e.message.includes("insufficient")) return e.message;
    return e.message || fallback;
  }
  if (typeof e === "string") return e;
  return fallback;
}

/**
 * EVM-specific hook that wraps interaction with the Holanc SDK.
 * Uses wagmi wallet client, converts to ethers Signer, instantiates EvmAdapter.
 */
export function useEvmHolanc() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { evmConfig } = useChainContext();

  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const walletRef = useRef<HolancWallet | null>(null);
  const proverRef = useRef<HolancProver | null>(null);
  const adapterRef = useRef<EvmAdapter | null>(null);

  // Initialize SDK wallet and prover on mount
  useEffect(() => {
    async function init() {
      if (!proverRef.current) {
        proverRef.current = new HolancProver();
      }
      if (!walletRef.current) {
        let mnemonic = localStorage.getItem(MNEMONIC_KEY);
        if (mnemonic) {
          walletRef.current = await HolancWallet.fromMnemonic(mnemonic);
        } else {
          const [w, m] = await HolancWallet.generate();
          walletRef.current = w;
          localStorage.setItem(MNEMONIC_KEY, m);
        }
      }
    }
    init();
  }, []);

  // Create/update EvmAdapter when wallet client changes
  useEffect(() => {
    async function initAdapter() {
      if (!walletClient || !evmConfig.poolAddress) {
        adapterRef.current = null;
        return;
      }
      const provider = new BrowserProvider(walletClient);
      const signer = await provider.getSigner();
      adapterRef.current = await EvmAdapter.create({
        rpcUrl: evmConfig.rpcUrl,
        poolAddress: evmConfig.poolAddress,
        verifierAddress: evmConfig.verifierAddress,
        nullifierAddress: evmConfig.nullifierAddress,
        signer: signer as any, // ethers v6 JsonRpcSigner → SDK expects v5 Signer type
      });
    }
    initAdapter();
  }, [walletClient, evmConfig]);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setTxSignature(null);
    setNote(null);
  }, []);

  // ── Deposit ──────────────────────────────────────────────────────────
  const deposit = useCallback(
    async (amountHuman: number) => {
      if (!isConnected) throw new Error("Wallet not connected");
      if (!walletRef.current || !proverRef.current || !adapterRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        const wallet = walletRef.current;
        const prover = proverRef.current;
        const adapter = adapterRef.current;
        const amount = BigInt(Math.round(amountHuman * 1e18));

        setStatus("generating");
        const depositNote = await wallet.createDepositNote(amount);
        const commitment = await wallet.computeCommitment(depositNote);

        await prover.proveDeposit(
          depositNote.owner,
          depositNote.value,
          depositNote.assetId,
          depositNote.blinding,
        );

        setStatus("sending");
        const result = await adapter.deposit({
          amount,
          commitment: `0x${commitment}`,
          encryptedNote: new Uint8Array(0),
          tokenAddress: evmConfig.tokenAddress,
        });

        setNote(result.commitment);
        setTxSignature(result.txSignature);
        setStatus("done");
      } catch (e: unknown) {
        setError(describeError(e, "Deposit failed"));
        setStatus("error");
      }
    },
    [isConnected, evmConfig, reset],
  );

  // ── Transfer ─────────────────────────────────────────────────────────
  const transfer = useCallback(
    async (noteSecret: string, recipientPubkey: string, amount: number) => {
      if (!isConnected) throw new Error("Wallet not connected");
      if (!walletRef.current || !proverRef.current || !adapterRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        const wallet = walletRef.current;
        const prover = proverRef.current;
        const adapter = adapterRef.current;
        const transferAmount = BigInt(Math.round(amount * 1e18));

        setStatus("generating");
        const { inputNotes, outputNotes } = await wallet.prepareTransfer(
          recipientPubkey,
          transferAmount,
          0n,
        );

        const proof = await prover.proveTransfer({
          spendingKey: wallet.spendingKeyHex(),
          inputNotes,
          outputNotes,
          fee: 0n,
        });

        setStatus("sending");
        const result = await adapter.transfer({
          amount: transferAmount,
          merkleRoot: `0x${proof.publicSignals[0]}`,
          nullifiers: [
            `0x${proof.publicSignals[1]}`,
            `0x${proof.publicSignals[2]}`,
          ],
          outputCommitments: [
            `0x${proof.publicSignals[3]}`,
            `0x${proof.publicSignals[4]}`,
          ],
          fee: 0n,
          encryptedNotes: [new Uint8Array(0), new Uint8Array(0)],
          proof: proof.proof,
        });

        wallet.markSpent(inputNotes);

        setNote(proof.publicSignals[3]);
        setTxSignature(result.txSignature);
        setStatus("done");
      } catch (e: unknown) {
        setError(describeError(e, "Transfer failed"));
        setStatus("error");
      }
    },
    [isConnected, reset],
  );

  // ── Withdraw ─────────────────────────────────────────────────────────
  const withdraw = useCallback(
    async (noteSecret: string, recipientAddress: string, amount: number) => {
      if (!isConnected) throw new Error("Wallet not connected");
      if (!walletRef.current || !proverRef.current || !adapterRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        const wallet = walletRef.current;
        const prover = proverRef.current;
        const adapter = adapterRef.current;
        const withdrawAmount = BigInt(Math.round(amount * 1e18));

        setStatus("generating");
        const { inputNotes, outputNotes } = await wallet.prepareWithdraw(
          withdrawAmount,
          0n,
        );

        const proof = await prover.proveWithdraw({
          spendingKey: wallet.spendingKeyHex(),
          inputNotes,
          outputNotes,
          exitValue: withdrawAmount,
          fee: 0n,
        });

        setStatus("sending");
        const result = await adapter.withdraw({
          merkleRoot: `0x${proof.publicSignals[0]}`,
          nullifiers: [
            `0x${proof.publicSignals[1]}`,
            `0x${proof.publicSignals[2]}`,
          ],
          outputCommitments: [
            `0x${proof.publicSignals[3]}`,
            `0x${proof.publicSignals[4]}`,
          ],
          exitAmount: withdrawAmount,
          fee: 0n,
          recipientAddress,
          encryptedNotes: [new Uint8Array(0), new Uint8Array(0)],
          proof: proof.proof,
        });

        wallet.markSpent(inputNotes);

        setTxSignature(result.txSignature);
        setStatus("done");
      } catch (e: unknown) {
        setError(describeError(e, "Withdrawal failed"));
        setStatus("error");
      }
    },
    [isConnected, reset],
  );

  // ── Stealth Send ─────────────────────────────────────────────────────
  const stealthSendTo = useCallback(
    async (
      metaAddress: string,
      amountHuman: number,
    ): Promise<StealthSendResult | null> => {
      if (!isConnected) throw new Error("Wallet not connected");
      if (!walletRef.current || !adapterRef.current)
        throw new Error("SDK not ready");
      reset();
      try {
        setStatus("generating");
        const parts = metaAddress.split(":");
        if (
          parts.length !== 3 ||
          parts[0].length !== 64 ||
          parts[1].length !== 64 ||
          parts[2].length !== 64
        ) {
          throw new Error(
            "Invalid stealth meta-address. Expected format: spendingPubkey:viewingPubkeyX:viewingPubkeyY (64 hex chars each)",
          );
        }
        const meta: StealthMetaAddress = {
          spendingPubkey: parts[0],
          viewingPubkey: [parts[1], parts[2]],
        };

        const result = await stealthSend(meta);
        const amount = BigInt(Math.round(amountHuman * 1e18));
        const wallet = walletRef.current;
        const adapter = adapterRef.current;

        const depositNote = await wallet.createDepositNote(amount);
        const commitment = await wallet.computeCommitment(depositNote);

        setStatus("sending");
        const depositResult = await adapter.deposit({
          amount,
          commitment: `0x${commitment}`,
          encryptedNote: new TextEncoder().encode(
            result.ephemeralPubkey.join(":"),
          ),
          tokenAddress: evmConfig.tokenAddress,
        });

        setNote(result.stealthOwner);
        setTxSignature(depositResult.txSignature);
        setStatus("done");
        return result;
      } catch (e: unknown) {
        setError(describeError(e, "Stealth send failed"));
        setStatus("error");
        return null;
      }
    },
    [isConnected, evmConfig, reset],
  );

  // ── Stealth Scan ─────────────────────────────────────────────────────
  const stealthScanIncoming = useCallback(async (): Promise<
    StealthScanResult[]
  > => {
    if (!isConnected) throw new Error("Wallet not connected");
    if (!walletRef.current || !adapterRef.current)
      throw new Error("SDK not ready");
    reset();
    try {
      setStatus("generating");
      const wallet = walletRef.current;
      const adapter = adapterRef.current;
      const spendingPubkey = wallet.spendingKeyHex();
      const viewingKey = spendingPubkey;

      // Fetch recent commitment events
      const poolStatus = await adapter.getPoolStatus();
      const currentBlock = poolStatus.nextLeafIndex; // approximation
      const fromBlock = Math.max(0, currentBlock - 1000);
      const events = await adapter.getCommitments(fromBlock, currentBlock);

      const results: StealthScanResult[] = [];
      for (const ev of events) {
        const decoded = new TextDecoder().decode(ev.encryptedNote);
        // encryptedNote was stored as "ephX:ephY" for stealth notes
        const ephParts = decoded.split(":");
        if (
          ephParts.length === 2 &&
          ephParts[0].length === 64 &&
          ephParts[1].length === 64
        ) {
          const ephemeralPubkey: [string, string] = [ephParts[0], ephParts[1]];
          const scanResult = await stealthScan(
            viewingKey,
            spendingPubkey,
            ephemeralPubkey,
            ev.commitment,
          );
          if (scanResult.isOurs) {
            results.push(scanResult);
          }
        }
      }

      setNote(
        results.length > 0
          ? `Found ${results.length} stealth payment(s)`
          : null,
      );
      setStatus("done");
      return results;
    } catch (e: unknown) {
      setError(describeError(e, "Stealth scan failed"));
      setStatus("error");
      return [];
    }
  }, [isConnected, reset]);

  // ── Bridge (EVM-side stub) ───────────────────────────────────────────
  const bridgeTransfer = useCallback(
    async (
      _sourceChain: number,
      _destChain: number,
      _noteSecret: string,
      _amount: number,
    ): Promise<string | null> => {
      reset();
      setError("Cross-chain bridge is not yet available on EVM chains.");
      setStatus("error");
      return null;
    },
    [reset],
  );

  // ── Compliance: Disclose (EVM-side stub) ─────────────────────────────
  const discloseToOracle = useCallback(
    async (
      _noteSecret: string,
      _oracleAddress: string,
    ): Promise<string | null> => {
      reset();
      setError("Compliance disclosure is not yet available on EVM chains.");
      setStatus("error");
      return null;
    },
    [reset],
  );

  // ── Compliance: Wealth Proof (EVM-side stub) ─────────────────────────
  const generateWealthProof = useCallback(
    async (_thresholdSol: number): Promise<string | null> => {
      reset();
      setError("Wealth proofs are not yet available on EVM chains.");
      setStatus("error");
      return null;
    },
    [reset],
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
    stealthSendTo,
    stealthScanIncoming,
    bridgeTransfer,
    discloseToOracle,
    generateWealthProof,
    connected: isConnected,
    publicKey: address ?? null,
  };
}
