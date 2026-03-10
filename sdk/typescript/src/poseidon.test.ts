import {
  poseidonHash,
  poseidonHash2,
  poseidonHashHex,
  fieldToHex,
  hexToField,
} from "./poseidon";

describe("poseidon", () => {
  describe("fieldToHex / hexToField round-trip", () => {
    it("handles zero", () => {
      expect(fieldToHex(0n)).toBe("0".repeat(64));
      expect(hexToField("0".repeat(64))).toBe(0n);
    });

    it("handles non-zero value", () => {
      const val = 123456789n;
      const hex = fieldToHex(val);
      expect(hex).toHaveLength(64);
      expect(hexToField(hex)).toBe(val);
    });

    it("strips 0x prefix", () => {
      expect(hexToField("0x" + "0".repeat(62) + "ff")).toBe(255n);
    });
  });

  describe("poseidonHash", () => {
    it("hashes single element deterministically", async () => {
      const a = await poseidonHash([1n]);
      const b = await poseidonHash([1n]);
      expect(a).toBe(b);
      expect(typeof a).toBe("bigint");
      expect(a).not.toBe(0n);
    });

    it("hashes two elements deterministically", async () => {
      const a = await poseidonHash([1n, 2n]);
      const b = await poseidonHash([1n, 2n]);
      expect(a).toBe(b);
    });

    it("different inputs produce different outputs", async () => {
      const a = await poseidonHash([1n]);
      const b = await poseidonHash([2n]);
      expect(a).not.toBe(b);
    });
  });

  describe("poseidonHash2", () => {
    it("matches poseidonHash([a, b])", async () => {
      const h1 = await poseidonHash2(42n, 99n);
      const h2 = await poseidonHash([42n, 99n]);
      expect(h1).toBe(h2);
    });
  });

  describe("poseidonHashHex", () => {
    it("returns 64-char hex string", async () => {
      const hex = await poseidonHashHex([1n, 2n]);
      expect(hex).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(hex)).toBe(true);
    });

    it("is deterministic", async () => {
      const a = await poseidonHashHex([1n, 2n]);
      const b = await poseidonHashHex([1n, 2n]);
      expect(a).toBe(b);
    });
  });
});
