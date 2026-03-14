"use client";

import { useState, type ReactNode } from "react";

interface ProofStatusProps {
  status: "idle" | "generating" | "done" | "error";
  message?: string;
}

export function ProofStatus({ status, message }: ProofStatusProps) {
  if (status === "idle") return null;

  const styles = {
    generating:
      "border-yellow-300 bg-yellow-50 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300",
    done: "border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-900/20 dark:text-green-300",
    error:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300",
  };

  const labels = {
    generating: "Generating ZK proof…",
    done: "Proof ready",
    error: "Operation failed",
  };

  return (
    <div className={`rounded-lg border p-3 text-sm ${styles[status]}`}>
      <div className="flex items-center gap-2">
        {status === "generating" && (
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        <span className="font-medium">{labels[status]}</span>
      </div>
      {message && <p className="mt-1 text-xs opacity-80">{message}</p>}
    </div>
  );
}

interface PageShellProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function PageShell({ title, description, children }: PageShellProps) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold">{title}</h1>
      {description && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
      <div className="mt-6 space-y-4">{children}</div>
    </div>
  );
}

interface AmountInputProps {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  token?: string;
}

export function AmountInput({
  value,
  onChange,
  label = "Amount",
  token = "SOL",
}: AmountInputProps) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          className="input pr-14"
          placeholder="0.00"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (/^\d*\.?\d*$/.test(v)) onChange(v);
          }}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
          {token}
        </span>
      </div>
    </div>
  );
}

interface NoteDisplayProps {
  note: string;
  label?: string;
}

export function NoteDisplay({
  note,
  label = "Your Secret Note",
}: NoteDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(note);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-holanc-200 bg-holanc-50 p-4 dark:border-holanc-800 dark:bg-holanc-900/20">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-holanc-700 dark:text-holanc-300">
          {label}
        </span>
        <button
          onClick={handleCopy}
          className="text-xs text-holanc-600 hover:text-holanc-800 dark:text-holanc-400"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-xs text-gray-700 dark:text-gray-300">
        {note}
      </p>
      <p className="mt-2 text-xs text-red-600 dark:text-red-400">
        Save this note securely. It is required to withdraw or transfer your
        funds.
      </p>
    </div>
  );
}
