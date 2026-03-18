declare module "circomlibjs" {
  export function buildBabyjub(): Promise<{
    F: {
      e(value: bigint): unknown;
      toObject(el: unknown): bigint;
    };
    Base8: [unknown, unknown];
    subOrder: bigint;
    mulPointEscalar(point: [unknown, unknown], scalar: bigint): [unknown, unknown];
  }>;

  export function buildPoseidon(): Promise<{
    (inputs: bigint[]): Uint8Array;
    F: {
      toObject(el: Uint8Array): bigint;
    };
  }>;
}
