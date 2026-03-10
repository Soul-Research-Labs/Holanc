declare module "circomlibjs" {
  export function buildPoseidon(): Promise<{
    (inputs: bigint[]): Uint8Array;
    F: {
      toObject(el: Uint8Array): bigint;
    };
  }>;
}
