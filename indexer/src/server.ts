import http from "node:http";
import { NoteStore, IndexedNote } from "./store";
import { ReplicatedNoteStore } from "./replicated-store";
import { NoteScanner } from "./scanner";

const ALLOWED_ORIGINS = process.env.CORS_ORIGIN || "*";

/**
 * Lightweight HTTP server that exposes the indexed note store.
 *
 * Endpoints:
 *   GET /notes?from=<leaf>&to=<leaf>   — notes in a leaf-index range
 *   GET /notes?after=<leaf>&limit=N    — notes after a given leaf index
 *   GET /notes/:commitment             — single note by commitment hash
 *   GET /status                        — scanner metadata (count, max leaf)
 *   GET /health                        — health check
 */
export function createServer(store: NoteStore, port: number): http.Server {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    try {
      if (path === "/health") {
        sendJson(res, 200, { status: "ok" });
      } else if (path === "/status") {
        handleStatus(store, res);
      } else if (path === "/notes") {
        handleNotes(store, url, res);
      } else if (path.startsWith("/notes/")) {
        const commitment = path.slice("/notes/".length);
        handleNoteByCommitment(store, commitment, res);
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      sendJson(res, 500, { error: msg });
    }
  });

  server.listen(port, () => {
    console.log(`[indexer-api] listening on http://0.0.0.0:${port}`);
  });

  return server;
}

function handleStatus(store: NoteStore, res: http.ServerResponse): void {
  sendJson(res, 200, {
    noteCount: store.count(),
    maxLeafIndex: store.maxLeafIndex(),
    lastSignature: store.getLastSignature(),
  });
}

function handleNotes(
  store: NoteStore,
  url: URL,
  res: http.ServerResponse,
): void {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const after = url.searchParams.get("after");
  const limitParam = url.searchParams.get("limit");

  let notes: IndexedNote[];

  if (from !== null && to !== null) {
    const fromLeaf = parseInt(from, 10);
    const toLeaf = parseInt(to, 10);
    if (isNaN(fromLeaf) || isNaN(toLeaf)) {
      sendJson(res, 400, { error: "Invalid from/to parameters" });
      return;
    }
    notes = store.getNotesByRange(fromLeaf, toLeaf);
  } else if (after !== null) {
    const afterLeaf = parseInt(after, 10);
    if (isNaN(afterLeaf)) {
      sendJson(res, 400, { error: "Invalid after parameter" });
      return;
    }
    const limit = limitParam ? parseInt(limitParam, 10) : 1000;
    if (isNaN(limit) || limit < 1 || limit > 10000) {
      sendJson(res, 400, { error: "Invalid limit (1-10000)" });
      return;
    }
    notes = store.getNotesAfter(afterLeaf, limit);
  } else {
    // Default: last 100 notes
    const maxLeaf = store.maxLeafIndex();
    notes = store.getNotesAfter(Math.max(0, maxLeaf - 99), 100);
  }

  sendJson(res, 200, { notes });
}

function handleNoteByCommitment(
  store: NoteStore,
  commitment: string,
  res: http.ServerResponse,
): void {
  // Validate commitment is hex (32 bytes = 64 hex chars)
  if (!/^[0-9a-fA-F]{64}$/.test(commitment)) {
    sendJson(res, 400, {
      error: "Invalid commitment hash (expected 64 hex chars)",
    });
    return;
  }

  const note = store.getNoteByCommitment(commitment);
  if (!note) {
    sendJson(res, 404, { error: "Note not found" });
    return;
  }

  sendJson(res, 200, { note });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Main entry point — runs scanner + HTTP server together
// ---------------------------------------------------------------------------
if (require.main === module) {
  const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const DB_PATH = process.env.INDEXER_DB_PATH || "./holanc-indexer.db";
  const PORT = parseInt(process.env.INDEXER_PORT || "3002", 10);
  const REPLICA_PATHS = process.env.INDEXER_REPLICA_PATHS
    ? process.env.INDEXER_REPLICA_PATHS.split(",").map((p) => p.trim())
    : [];

  // Use replicated store when replica paths are configured for HA reads
  const store =
    REPLICA_PATHS.length > 0
      ? new ReplicatedNoteStore(DB_PATH, REPLICA_PATHS)
      : new NoteStore(DB_PATH);
  const scanner = new NoteScanner(RPC_URL, store as NoteStore);
  const server = createServer(store as NoteStore, PORT);

  process.on("SIGINT", () => {
    console.log("\n[indexer] shutting down...");
    scanner.stop();
    server.close();
    store.close();
    process.exit(0);
  });

  scanner.start().catch((err) => {
    console.error("[scanner] fatal:", err);
    process.exit(1);
  });
}
