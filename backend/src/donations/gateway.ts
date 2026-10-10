// The only place that talks to Solana. Tests replace it with an in-memory ledger.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

export interface TransferInfo {
  signature: string;
  ok: boolean; // transaction succeeded (meta.err == null) at "confirmed" or better
  accountKeys: string[];
  // lamports gained by each account (post - pre), indexed like accountKeys
  deltas: number[];
  feePayer: string;
  blockTime: number | null;
}

export interface SolanaGateway {
  newWallet(): { publicKey: string; secretKey: Uint8Array };
  getTransfer(signature: string): Promise<TransferInfo | null>;
  // Most recent confirmed signature that includes `reference` as an account key.
  findSignatureByReference(reference: string): Promise<string | null>;
  getBalance(publicKey: string): Promise<number>;
  transfer(secretKey: Uint8Array, destination: string, lamports: number): Promise<string>;
  readonly feeLamports: number;
}

export function isValidAddress(s: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(s).toBytes()) && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

export function newReference(): string {
  return Keypair.generate().publicKey.toBase58();
}

export class Web3Gateway implements SolanaGateway {
  private connection: Connection;
  readonly feeLamports = 5000;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  newWallet() {
    const kp = Keypair.generate();
    return { publicKey: kp.publicKey.toBase58(), secretKey: kp.secretKey };
  }

  async getTransfer(signature: string): Promise<TransferInfo | null> {
    const tx = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).keySegments().flat();
    const accountKeys = keys.map((k) => k.toBase58());
    return {
      signature,
      ok: tx.meta.err === null,
      accountKeys,
      deltas: accountKeys.map((_, i) => (tx.meta!.postBalances[i] ?? 0) - (tx.meta!.preBalances[i] ?? 0)),
      feePayer: accountKeys[0],
      blockTime: tx.blockTime ?? null,
    };
  }

  async findSignatureByReference(reference: string) {
    const sigs = await this.connection.getSignaturesForAddress(new PublicKey(reference), { limit: 5 }, 'confirmed');
    return sigs.find((s) => !s.err)?.signature ?? null;
  }

  getBalance(publicKey: string) {
    return this.connection.getBalance(new PublicKey(publicKey), 'confirmed');
  }

  async transfer(secretKey: Uint8Array, destination: string, lamports: number) {
    const from = Keypair.fromSecretKey(secretKey);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(destination), lamports }));
    return sendAndConfirmTransaction(this.connection, tx, [from], { commitment: 'confirmed' });
  }
}
