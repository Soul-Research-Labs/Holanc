import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";

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

  /**
   * Register a compliance oracle (auditor/regulator).
   */
  async registerOracle(
    payer: Keypair,
    oraclePubkey: PublicKey,
    oracleName: string,
    permissions: {
      canView: boolean;
      canRequestWealthProof: boolean;
      canFlag: boolean;
    },
  ): Promise<string> {
    const compliancePda = this.getCompliancePda(this.config.poolAddress);
    const oraclePda = this.getOraclePda(this.config.poolAddress, oraclePubkey);

    // Anchor discriminator for "register_oracle"
    const discriminator = Buffer.from([
      0x6e, 0x2a, 0xf1, 0xc5, 0x83, 0xd9, 0x47, 0xb2,
    ]);

    // oracle_pubkey: Pubkey (32 bytes)
    const oracleKeyBuf = oraclePubkey.toBuffer();

    // oracle_name: [u8; 32]
    const nameBuf = Buffer.alloc(32);
    Buffer.from(oracleName).copy(
      nameBuf,
      0,
      0,
      Math.min(oracleName.length, 32),
    );

    // OraclePermissions struct: 3 bools
    const permsBuf = Buffer.from([
      permissions.canView ? 1 : 0,
      permissions.canRequestWealthProof ? 1 : 0,
      permissions.canFlag ? 1 : 0,
    ]);

    const ix = new TransactionInstruction({
      programId: this.config.complianceProgramId,
      keys: [
        { pubkey: compliancePda, isSigner: false, isWritable: true },
        { pubkey: oraclePda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator, oracleKeyBuf, nameBuf, permsBuf]),
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Disclose a viewing key to a registered oracle.
   */
  async discloseViewingKey(
    payer: Keypair,
    oracle: PublicKey,
    encryptedViewingKey: Uint8Array,
    scope: DisclosureScope,
  ): Promise<string> {
    const compliancePda = this.getCompliancePda(this.config.poolAddress);
    const oraclePda = this.getOraclePda(this.config.poolAddress, oracle);
    const disclosurePda = this.getDisclosurePda(
      this.config.poolAddress,
      payer.publicKey,
      oracle,
    );

    // Anchor discriminator for "disclose_viewing_key"
    const discriminator = Buffer.from([
      0x8f, 0x3c, 0xe7, 0x54, 0x19, 0xab, 0x62, 0xd8,
    ]);

    // Vec<u8> encoding for encrypted_viewing_key
    const keyLenBuf = Buffer.alloc(4);
    keyLenBuf.writeUInt32LE(encryptedViewingKey.length);

    // DisclosureScope enum serialization
    const scopeBuf = this.serializeDisclosureScope(scope);

    const ix = new TransactionInstruction({
      programId: this.config.complianceProgramId,
      keys: [
        { pubkey: compliancePda, isSigner: false, isWritable: true },
        { pubkey: oraclePda, isSigner: false, isWritable: false },
        { pubkey: disclosurePda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator,
        keyLenBuf,
        Buffer.from(encryptedViewingKey),
        scopeBuf,
      ]),
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Revoke a previous viewing key disclosure.
   */
  async revokeDisclosure(payer: Keypair, oracle: PublicKey): Promise<string> {
    const disclosurePda = this.getDisclosurePda(
      this.config.poolAddress,
      payer.publicKey,
      oracle,
    );

    // Anchor discriminator for "revoke_disclosure"
    const discriminator = Buffer.from([
      0xa1, 0x5b, 0xe4, 0x37, 0xc2, 0x68, 0xf9, 0x13,
    ]);

    const ix = new TransactionInstruction({
      programId: this.config.complianceProgramId,
      keys: [
        { pubkey: disclosurePda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: discriminator,
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Submit a ZK wealth proof attestation.
   */
  async submitWealthProof(
    payer: Keypair,
    threshold: bigint,
    proofData: Uint8Array,
    circuitType: number,
  ): Promise<string> {
    const compliancePda = this.getCompliancePda(this.config.poolAddress);
    const wealthPda = this.getWealthAttestationPda(
      this.config.poolAddress,
      payer.publicKey,
    );

    // Anchor discriminator for "submit_wealth_proof"
    const discriminator = Buffer.from([
      0xd2, 0x47, 0x83, 0xbc, 0x5a, 0xf1, 0x96, 0x0e,
    ]);

    const thresholdBuf = Buffer.alloc(8);
    thresholdBuf.writeBigUInt64LE(threshold);

    // Vec<u8> encoding for proof_data
    const proofLenBuf = Buffer.alloc(4);
    proofLenBuf.writeUInt32LE(proofData.length);

    const circuitBuf = Buffer.from([circuitType]);

    const ix = new TransactionInstruction({
      programId: this.config.complianceProgramId,
      keys: [
        { pubkey: compliancePda, isSigner: false, isWritable: false },
        { pubkey: wealthPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator,
        thresholdBuf,
        proofLenBuf,
        Buffer.from(proofData),
        circuitBuf,
      ]),
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  private serializeDisclosureScope(scope: DisclosureScope): Buffer {
    // Borsh enum: variant index (1 byte) + variant data
    if (scope === DisclosureScope.Full) {
      return Buffer.from([0]);
    } else if (scope === DisclosureScope.TimeBounded) {
      return Buffer.from([1]);
    } else {
      return Buffer.from([2]);
    }
  }
}
