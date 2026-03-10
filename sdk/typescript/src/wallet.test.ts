import { HolancWallet } from "./wallet";

describe("HolancWallet", () => {
  describe("generate", () => {
    it("creates wallet with 12-word mnemonic", async () => {
      const [wallet, mnemonic] = await HolancWallet.generate();
      expect(mnemonic.split(" ")).toHaveLength(12);
      expect(wallet.spendingKeyHex()).toHaveLength(64);
    });
  });

  describe("fromMnemonic", () => {
    it("restores same wallet from same mnemonic", async () => {
      const [, mnemonic] = await HolancWallet.generate();
      const w1 = await HolancWallet.fromMnemonic(mnemonic);
      const w2 = await HolancWallet.fromMnemonic(mnemonic);
      expect(w1.spendingKeyHex()).toBe(w2.spendingKeyHex());
    });

    it("rejects invalid mnemonic", async () => {
      await expect(HolancWallet.fromMnemonic("invalid words")).rejects.toThrow(
        "Invalid mnemonic",
      );
    });
  });

  describe("fromKey", () => {
    it("creates wallet from 32-byte key", async () => {
      const key = new Uint8Array(32);
      key[0] = 42;
      const wallet = await HolancWallet.fromKey(key);
      expect(wallet.spendingKeyHex()).toHaveLength(64);
    });

    it("rejects wrong key length", async () => {
      const key = new Uint8Array(16);
      await expect(HolancWallet.fromKey(key)).rejects.toThrow("32 bytes");
    });
  });

  describe("balance and notes", () => {
    it("starts with zero balance", async () => {
      const wallet = await HolancWallet.random();
      expect(wallet.balance()).toBe(0n);
      expect(wallet.unspentNotes()).toHaveLength(0);
    });

    it("reflects deposit in balance", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(1000n);
      expect(wallet.balance()).toBe(1000n);
      expect(wallet.unspentNotes()).toHaveLength(1);
    });

    it("multiple deposits sum correctly", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(500n);
      await wallet.createDepositNote(300n);
      expect(wallet.balance()).toBe(800n);
      expect(wallet.unspentNotes()).toHaveLength(2);
    });
  });

  describe("createDepositNote", () => {
    it("produces note with commitment and nullifier", async () => {
      const wallet = await HolancWallet.random();
      const note = await wallet.createDepositNote(1000n);
      expect(note.commitment).toHaveLength(64);
      expect(note.nullifier).toHaveLength(64);
      expect(note.value).toBe(1000n);
      expect(note.spent).toBe(false);
    });

    it("different notes have different commitments", async () => {
      const wallet = await HolancWallet.random();
      const n1 = await wallet.createDepositNote(100n);
      const n2 = await wallet.createDepositNote(100n);
      expect(n1.commitment).not.toBe(n2.commitment);
    });

    it("commitment is deterministic for same inputs", async () => {
      const wallet = await HolancWallet.random();
      const note = await wallet.createDepositNote(100n);
      const recomputed = await wallet.computeCommitment(note);
      expect(note.commitment).toBe(recomputed);
    });
  });

  describe("selectNotes", () => {
    it("selects single note when sufficient", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(1000n);
      const selected = wallet.selectNotes(500n);
      expect(selected).toHaveLength(1);
    });

    it("selects two notes when single is insufficient", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(300n);
      await wallet.createDepositNote(400n);
      const selected = wallet.selectNotes(600n);
      expect(selected).toHaveLength(2);
    });

    it("throws when insufficient balance", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(100n);
      expect(() => wallet.selectNotes(200n)).toThrow("Insufficient balance");
    });
  });

  describe("prepareTransfer", () => {
    it("produces correct input/output notes", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(1000n);
      const recipient = "ab".repeat(32);
      const { inputNotes, outputNotes } = await wallet.prepareTransfer(
        recipient,
        500n,
        10n,
      );
      expect(inputNotes).toHaveLength(1);
      expect(outputNotes.length).toBeGreaterThanOrEqual(1);

      const recipientNote = outputNotes.find((n) => n.owner === recipient);
      expect(recipientNote).toBeDefined();
      expect(recipientNote!.value).toBe(500n);

      // Change note should exist (1000 - 500 - 10 = 490)
      if (outputNotes.length === 2) {
        const changeNote = outputNotes.find(
          (n) => n.owner === wallet.spendingKeyHex(),
        );
        expect(changeNote).toBeDefined();
        expect(changeNote!.value).toBe(490n);
      }
    });
  });

  describe("prepareWithdraw", () => {
    it("produces change output", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(1000n);
      const { inputNotes, outputNotes } = await wallet.prepareWithdraw(
        500n,
        10n,
      );
      expect(inputNotes).toHaveLength(1);
      // Change: 1000 - 500 - 10 = 490
      expect(outputNotes).toHaveLength(1);
      expect(outputNotes[0].value).toBe(490n);
    });

    it("no change output when exact amount", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(510n);
      const { outputNotes } = await wallet.prepareWithdraw(500n, 10n);
      expect(outputNotes).toHaveLength(0);
    });
  });

  describe("markSpent", () => {
    it("marks matched notes as spent", async () => {
      const wallet = await HolancWallet.random();
      const note = await wallet.createDepositNote(1000n);
      expect(wallet.balance()).toBe(1000n);
      wallet.markSpent([note]);
      expect(wallet.balance()).toBe(0n);
      expect(wallet.unspentNotes()).toHaveLength(0);
    });
  });

  describe("history", () => {
    it("records deposit and transfer events", async () => {
      const wallet = await HolancWallet.random();
      await wallet.createDepositNote(1000n);
      await wallet.prepareTransfer("ab".repeat(32), 100n, 0n);
      const h = wallet.history();
      expect(h).toHaveLength(2);
      expect(h[0].kind).toBe("deposit");
      expect(h[1].kind).toBe("send");
    });
  });
});
