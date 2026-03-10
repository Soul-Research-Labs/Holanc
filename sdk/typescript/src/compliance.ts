import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Compliance client for the Holanc privacy protocol.
 *
 * Manages optional compliance hooks: oracle registration, viewing key
 * disclosure, and ZK wealth proof attestations.
 */

/** Compliance mode for the pool. */
export enum ComplianceMode {
  /** No compliance requirements. */
  Permissionless = 0,
  /** Users may optionally disclose viewing keys to oracles. */
  OptionalDisclosure = 1,
  /** Viewing key disclosure is required for deposits above a threshold. */
  MandatoryDisclosure = 2,
}

/** Scope of a viewing key disclosure. */
export enum DisclosureScope {
  /** Full disclosure — oracle can see all activity. */
  Full = 0,
  /** Disclosure only covers a time range. */
  TimeBounded = 1,
  /** Disclosure only covers amounts above a threshold. */
  AmountBounded = 2,
}

/** Oracle permissions bitmap. */
export const OraclePermissions = {
  ViewBalance: 1 << 0,
  ViewTransactions: 1 << 1,
  ViewIdentity: 1 << 2,
  AttestWealth: 1 << 3,
  Freeze: 1 << 4,
} as const;

/** Compliance configuration for a pool. */
export interface ComplianceConfig {
  complianceProgramId: PublicKey;
  poolAddress: PublicKey;
}

/** Oracle record from on-chain state. */
export interface OracleRecord {
  oracle: PublicKey;
  name: string;
  permissions: number;
  isActive: boolean;
  registeredAt: number;
}

/** Disclosure record from on-chain state. */
export interface DisclosureRecord {
  user: PublicKey;
  oracle: PublicKey;
  scope: DisclosureScope;
  encryptedViewingKey: Uint8Array;
  validFrom: number;
  validUntil: number;
  isRevoked: boolean;
}

/** Wealth attestation from on-chain state. */
export interface WealthAttestation {
  owner: PublicKey;
  thresholdLamports: bigint;
  attestedAt: number;
  expiresAt: number;
  oracle: PublicKey;
  isValid: boolean;
}

const COMPLIANCE_PROGRAM_ID = new PublicKey(
  "8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE",
);

/**
 * HolancCompliance — client for optional regulatory compliance features.
 */
export class HolancCompliance {
  private connection: Connection;
  private config: ComplianceConfig;

  constructor(connection: Connection, config: Partial<ComplianceConfig> = {}) {
    this.connection = connection;
    this.config = {
      complianceProgramId: config.complianceProgramId ?? COMPLIANCE_PROGRAM_ID,
      poolAddress: config.poolAddress ?? PublicKey.default,
    };
  }

  /**
   * Get the compliance config PDA.
   */
  getCompliancePda(poolAddress: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("compliance"), poolAddress.toBuffer()],
      this.config.complianceProgramId,
    );
    return pda;
  }

  /**
   * Get the oracle record PDA.
   */
  getOraclePda(poolAddress: PublicKey, oracle: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle"), poolAddress.toBuffer(), oracle.toBuffer()],
      this.config.complianceProgramId,
    );
    return pda;
  }

  /**
   * Get the disclosure PDA for a specific user + oracle pair.
   */
  getDisclosurePda(
    poolAddress: PublicKey,
    user: PublicKey,
    oracle: PublicKey,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("disclosure"),
        poolAddress.toBuffer(),
        user.toBuffer(),
        oracle.toBuffer(),
      ],
      this.config.complianceProgramId,
    );
    return pda;
  }

  /**
   * Get the wealth attestation PDA.
   */
  getWealthAttestationPda(poolAddress: PublicKey, owner: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wealth"), poolAddress.toBuffer(), owner.toBuffer()],
      this.config.complianceProgramId,
    );
    return pda;
  }

  /**
   * Fetch an oracle record from on-chain state.
   */
  async getOracle(oracle: PublicKey): Promise<OracleRecord | null> {
    const pda = this.getOraclePda(this.config.poolAddress, oracle);
    const info = await this.connection.getAccountInfo(pda);
    if (!info) return null;

    const data = info.data.slice(8); // skip Anchor discriminator
    return {
      oracle,
      name: data.slice(32, 64).toString("utf8").replace(/\0/g, ""),
      permissions: data.readUInt8(64),
      isActive: data.readUInt8(65) === 1,
      registeredAt: Number(data.readBigInt64LE(66)),
    };
  }

  /**
   * Fetch a wealth attestation from on-chain state.
   */
  async getWealthAttestation(
    owner: PublicKey,
  ): Promise<WealthAttestation | null> {
    const pda = this.getWealthAttestationPda(this.config.poolAddress, owner);
    const info = await this.connection.getAccountInfo(pda);
    if (!info) return null;

    const data = info.data.slice(8);
    return {
      owner,
      thresholdLamports: data.readBigUInt64LE(32),
      attestedAt: Number(data.readBigInt64LE(40)),
      expiresAt: Number(data.readBigInt64LE(48)),
      oracle: new PublicKey(data.slice(56, 88)),
      isValid: data.readUInt8(88) === 1,
    };
  }

  /**
   * Check if a wealth attestation is currently valid and not expired.
   */
  async isWealthAttestationValid(owner: PublicKey): Promise<boolean> {
    const attestation = await this.getWealthAttestation(owner);
    if (!attestation) return false;
    if (!attestation.isValid) return false;
    const now = Math.floor(Date.now() / 1000);
    return now < attestation.expiresAt;
  }
}
