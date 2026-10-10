// Optional Solana donations with one custodial wallet per gallery.
//
// Donating never trusts the client: a donation counts only after its transaction is
// read back from the cluster and shown to (a) have succeeded, (b) include this intent's
// unique reference key, and (c) credit the gallery wallet with at least the minimum (and
// the requested amount, if any). A signature can be counted once.
// Withdrawals: owner only, password re-entry, idempotent requestId, rate-limited, one at a
// time per gallery. Secret keys are decrypted only in memory, only to sign a withdrawal.
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { verifyPassword } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rate-limit.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { isValidAddress, newReference, type SolanaGateway } from './gateway.js';
import { decryptSecret, encryptSecret } from './vault.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function lamportsToSol(l: number | string | bigint): string {
  const v = BigInt(l);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const aad = (galleryId: string, publicKey: string) => `${galleryId}:${publicKey}`;

export class DonationService {
  private withdrawLimiter: RateLimiter;
  private withdrawing = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private deps: {
      db: Db;
      config: Config;
      gateway: SolanaGateway | null;
      hub: RealtimeHub;
      log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
    },
  ) {
    this.withdrawLimiter = new RateLimiter(deps.config.solana.withdrawalsPerHour, 3600_000);
  }

  get enabled() {
    return this.deps.config.solana.enabled && this.deps.gateway !== null;
  }

  private get gateway(): SolanaGateway {
    if (!this.enabled) throw new AppError('NOT_FOUND', { what: 'donations', reason: 'donations are not enabled on this server' });
    return this.deps.gateway!;
  }

  private get key(): Buffer {
    return this.deps.config.solana.encryptionKey!;
  }

  // ---- Configuration (owner) ------------------------------------------------

  async configure(galleryId: string, input: { enabled: boolean; message?: string }) {
    const gw = this.gateway;
    const existing = await this.wallet(galleryId);
    if (!existing) {
      if (!input.enabled) return this.publicInfo(galleryId);
      const w = gw.newWallet();
      await this.deps.db.query(
        `INSERT INTO donation_wallets (gallery_id, cluster, public_key, encrypted_secret, enabled, message) VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (gallery_id) DO NOTHING`,
        [galleryId, this.deps.config.solana.cluster, w.publicKey, encryptSecret(this.key, w.secretKey, aad(galleryId, w.publicKey)), input.message ?? ''],
      );
      w.secretKey.fill(0);
    } else {
      await this.deps.db.query(`UPDATE donation_wallets SET enabled = $2, message = COALESCE($3, message), updated_at = now() WHERE gallery_id = $1`, [
        galleryId,
        input.enabled,
        input.message ?? null,
      ]);
    }
    const info = await this.publicInfo(galleryId);
    this.deps.hub.broadcast(galleryId, { type: 'donations', galleryId, summary: info });
    return info;
  }

  private async wallet(galleryId: string) {
    const { rows } = await this.deps.db.query(`SELECT * FROM donation_wallets WHERE gallery_id = $1`, [galleryId]);
    return rows[0] ?? null;
  }

  // ---- Public summary (anyone who can view the gallery) ---------------------

  async publicInfo(galleryId: string) {
    this.gateway;
    const w = await this.wallet(galleryId);
    const { rows: t } = await this.deps.db.query(
      `SELECT COALESCE(sum(lamports), 0)::text AS total, count(*)::int AS n FROM donations WHERE gallery_id = $1 AND status = 'confirmed'`,
      [galleryId],
    );
    const { rows: recent } = await this.deps.db.query(
      `SELECT id, lamports, donor_name, donor_message, confirmed_at, signature FROM donations
       WHERE gallery_id = $1 AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 10`,
      [galleryId],
    );
    return {
      galleryId,
      enabled: !!w?.enabled,
      cluster: this.deps.config.solana.cluster,
      address: w?.enabled ? (w.public_key as string) : null,
      message: (w?.message as string) ?? '',
      totalLamports: Number(t[0].total),
      totalSol: lamportsToSol(t[0].total),
      donationCount: t[0].n,
      recent: recent.map((r) => this.publicDonation(r)),
      disclaimer:
        'Donations go to a wallet held by this service for the gallery owner, who can withdraw them. Blockchain transfers cannot be reversed by the service.',
    };
  }

  private publicDonation(r: any) {
    return {
      id: r.id as string,
      lamports: Number(r.lamports),
      sol: lamportsToSol(r.lamports),
      donorName: (r.donor_name as string) || null,
      message: (r.donor_message as string) || null,
      confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
      signature: r.signature as string,
      explorerUrl: this.explorer(r.signature),
    };
  }

  private explorer(signature: string) {
    const c = this.deps.config.solana.cluster;
    return `https://explorer.solana.com/tx/${signature}${c === 'mainnet-beta' ? '' : `?cluster=${c}`}`;
  }

  // ---- Donating -----------------------------------------------------------------

  async createIntent(galleryId: string, input: { lamports?: number; donorName?: string; message?: string; donorUserId: string | null; label: string }) {
    this.gateway;
    const w = await this.wallet(galleryId);
    if (!w?.enabled) throw new AppError('NOT_FOUND', { what: 'donations', reason: 'donations are not enabled for this gallery' });
    const min = this.deps.config.solana.minDonationLamports;
    if (input.lamports !== undefined && input.lamports < min) throw new AppError('VALIDATION_FAILED', { field: 'lamports', minLamports: min });
    const reference = newReference();
    const expiresAt = new Date(Date.now() + this.deps.config.solana.intentTtlSec * 1000);
    const { rows } = await this.deps.db.query(
      `INSERT INTO donations (gallery_id, wallet, reference, requested_lamports, donor_user_id, donor_name, donor_message, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *`,
      [galleryId, w.public_key, reference, input.lamports ?? null, input.donorUserId, (input.donorName ?? '').trim(), (input.message ?? '').trim(), expiresAt],
    );
    return this.intentView(rows[0], input.label);
  }

  private intentView(r: any, label = 'Gallery donation') {
    const params = new URLSearchParams();
    if (r.requested_lamports) params.set('amount', lamportsToSol(r.requested_lamports));
    params.set('reference', r.reference);
    params.set('label', label.slice(0, 60));
    params.set('message', 'Thank you for supporting this gallery');
    return {
      id: r.id as string,
      galleryId: r.gallery_id as string,
      status: r.status as 'pending' | 'confirmed' | 'expired',
      cluster: this.deps.config.solana.cluster,
      recipient: r.wallet as string,
      reference: r.reference as string,
      requestedLamports: r.requested_lamports === null ? null : Number(r.requested_lamports),
      solanaPayUrl: `solana:${r.wallet}?${params.toString()}`,
      expiresAt: new Date(r.expires_at).toISOString(),
      donation: r.status === 'confirmed' ? this.publicDonation(r) : null,
    };
  }

  async getIntent(id: string) {
    const { rows } = await this.deps.db.query(`SELECT * FROM donations WHERE id = $1`, [id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', { what: 'donation' });
    return rows[0];
  }

  view(row: any) {
    return this.intentView(row);
  }

  // Verifies a reported signature (or one found by the poller) against the intent.
  async confirm(id: string, signature: string) {
    const gw = this.gateway;
    const intent = await this.getIntent(id);
    if (intent.status === 'confirmed') {
      if (intent.signature === signature) return this.intentView(intent);
      throw new AppError('DONATION_UNVERIFIED', { reason: 'already_confirmed_with_another_signature' });
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new AppError('VALIDATION_FAILED', { field: 'signature' });
    const tx = await gw.getTransfer(signature);
    if (!tx) throw new AppError('DONATION_UNVERIFIED', { reason: 'not_found_yet', retryable: true });
    if (!tx.ok) throw new AppError('DONATION_UNVERIFIED', { reason: 'transaction_failed' });
    if (!tx.accountKeys.includes(intent.reference)) throw new AppError('DONATION_UNVERIFIED', { reason: 'reference_missing' });
    const idx = tx.accountKeys.indexOf(intent.wallet);
    const received = idx >= 0 ? tx.deltas[idx] : 0;
    if (received < this.deps.config.solana.minDonationLamports) throw new AppError('DONATION_UNVERIFIED', { reason: 'wallet_not_credited' });
    if (intent.requested_lamports !== null && received < Number(intent.requested_lamports))
      throw new AppError('DONATION_UNVERIFIED', { reason: 'amount_too_low', receivedLamports: received });

    let row: any;
    try {
      const { rows } = await this.deps.db.query(
        `UPDATE donations SET status = 'confirmed', signature = $2, lamports = $3, from_address = $4, confirmed_at = now()
         WHERE id = $1 AND status IN ('pending', 'expired') RETURNING *`,
        [id, signature, received, tx.feePayer],
      );
      row = rows[0];
    } catch (err: any) {
      if (err.code === '23505') throw new AppError('DONATION_UNVERIFIED', { reason: 'signature_already_counted' });
      throw err;
    }
    if (!row) return this.intentView(await this.getIntent(id)); // confirmed concurrently
    const summary = await this.publicInfo(intent.gallery_id);
    this.deps.hub.broadcast(intent.gallery_id, { type: 'donation', galleryId: intent.gallery_id, donation: this.publicDonation(row), summary });
    return this.intentView(row);
  }

  // Background: catches donations whose browser never reported the signature.
  async pollPending(limit = 20) {
    if (!this.enabled) return 0;
    await this.deps.db.query(`UPDATE donations SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`);
    const { rows } = await this.deps.db.query(`SELECT id, reference FROM donations WHERE status = 'pending' ORDER BY created_at LIMIT $1`, [limit]);
    let confirmed = 0;
    for (const r of rows) {
      try {
        const sig = await this.deps.gateway!.findSignatureByReference(r.reference);
        if (sig) {
          await this.confirm(r.id, sig);
          confirmed++;
        }
      } catch (err) {
        if (!(err instanceof AppError)) this.deps.log.warn({ err: String(err), donationId: r.id }, 'donation poll failed');
      }
    }
    return confirmed;
  }

  startPolling() {
    if (!this.enabled || this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollPending(), this.deps.config.solana.pollIntervalMs);
    this.pollTimer.unref();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // ---- Owner wallet management ------------------------------------------------

  async walletInfo(galleryId: string) {
    const gw = this.gateway;
    const w = await this.wallet(galleryId);
    if (!w) throw new AppError('NOT_FOUND', { what: 'donation wallet' });
    const balance = await gw.getBalance(w.public_key);
    const { rows } = await this.deps.db.query(
      `SELECT w.*, u.display_name FROM donation_withdrawals w JOIN users u ON u.id = w.requested_by WHERE w.gallery_id = $1 ORDER BY w.created_at DESC LIMIT 20`,
      [galleryId],
    );
    return {
      galleryId,
      cluster: this.deps.config.solana.cluster,
      address: w.public_key as string,
      enabled: w.enabled as boolean,
      balanceLamports: balance,
      balanceSol: lamportsToSol(balance),
      networkFeeLamports: gw.feeLamports,
      withdrawals: rows.map((r) => this.withdrawalView(r)),
    };
  }

  private withdrawalView(r: any) {
    return {
      id: r.id as string,
      requestId: r.request_id as string,
      destination: r.destination as string,
      lamports: Number(r.lamports),
      sol: lamportsToSol(r.lamports),
      status: r.status as string,
      signature: r.signature as string | null,
      explorerUrl: r.signature ? this.explorer(r.signature) : null,
      error: r.error as string | null,
      requestedBy: r.display_name as string | undefined,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async withdraw(galleryId: string, userId: string, input: { requestId: string; destination: string; lamports: number | 'all'; password: string }) {
    const gw = this.gateway;
    const { rows: u } = await this.deps.db.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    if (!u[0] || !(await verifyPassword(input.password, u[0].password_hash))) throw new AppError('INVALID_CREDENTIALS');

    const existing = await this.deps.db.query(`SELECT * FROM donation_withdrawals WHERE gallery_id = $1 AND request_id = $2`, [galleryId, input.requestId]);
    if (existing.rows[0]) return { ...this.withdrawalView(existing.rows[0]), duplicate: true };

    if (!isValidAddress(input.destination)) throw new AppError('VALIDATION_FAILED', { field: 'destination', reason: 'not a valid Solana wallet address' });
    const w = await this.wallet(galleryId);
    if (!w) throw new AppError('NOT_FOUND', { what: 'donation wallet' });
    if (input.destination === w.public_key) throw new AppError('VALIDATION_FAILED', { field: 'destination', reason: 'cannot withdraw to the donation wallet itself' });
    if (this.withdrawing.has(galleryId)) throw new AppError('RATE_LIMITED', { reason: 'another withdrawal is in progress' });
    if (!this.withdrawLimiter.take(galleryId)) throw new AppError('RATE_LIMITED', { perHour: this.deps.config.solana.withdrawalsPerHour });

    this.withdrawing.add(galleryId);
    try {
      const balance = await gw.getBalance(w.public_key);
      const lamports = input.lamports === 'all' ? balance - gw.feeLamports : input.lamports;
      if (!Number.isSafeInteger(lamports) || lamports <= 0 || lamports + gw.feeLamports > balance)
        throw new AppError('INSUFFICIENT_FUNDS', { balanceLamports: balance, networkFeeLamports: gw.feeLamports });

      const id = randomUUID();
      const { rows } = await this.deps.db.query(
        `INSERT INTO donation_withdrawals (id, gallery_id, requested_by, request_id, destination, lamports, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') ON CONFLICT (gallery_id, request_id) DO NOTHING RETURNING *`,
        [id, galleryId, userId, input.requestId, input.destination, lamports],
      );
      if (!rows[0]) {
        const again = await this.deps.db.query(`SELECT * FROM donation_withdrawals WHERE gallery_id = $1 AND request_id = $2`, [galleryId, input.requestId]);
        return { ...this.withdrawalView(again.rows[0]), duplicate: true };
      }
      this.deps.log.info({ galleryId, withdrawalId: id, lamports, destination: input.destination }, 'donation withdrawal requested');
      const secret = decryptSecret(this.key, w.encrypted_secret, aad(galleryId, w.public_key));
      let status = 'confirmed';
      let signature: string | null = null;
      let error: string | null = null;
      try {
        signature = await gw.transfer(secret, input.destination, lamports);
      } catch (err: any) {
        status = 'failed';
        // The transfer may still land if only confirmation timed out: the explorer is authoritative.
        error = String(err?.message ?? err).slice(0, 300);
      } finally {
        secret.fill(0);
      }
      const { rows: done } = await this.deps.db.query(
        `UPDATE donation_withdrawals SET status = $2, signature = $3, error = $4, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status, signature, error],
      );
      return { ...this.withdrawalView(done[0]), duplicate: false };
    } finally {
      this.withdrawing.delete(galleryId);
    }
  }
}
