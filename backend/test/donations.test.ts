// Donation tests against an IN-MEMORY LEDGER standing in for the Solana RPC. Real Solana
// keypairs, the real encryption, verification and withdrawal code run unchanged; only the
// network is simulated. A real devnet run is a separate manual check (docs/donations.md).
import { Keypair } from '@solana/web3.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SolanaGateway, TransferInfo } from '../src/donations/gateway.js';
import { decryptSecret } from '../src/donations/vault.js';
import { addMember, client, connectAndSync, createGallery, registerUser, startServer, type TestServer } from './helpers.js';

class FakeLedger implements SolanaGateway {
  readonly feeLamports = 5000;
  balances = new Map<string, number>();
  txs = new Map<string, TransferInfo>();

  newWallet() {
    const kp = Keypair.generate();
    return { publicKey: kp.publicKey.toBase58(), secretKey: kp.secretKey };
  }

  private sig() {
    return Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58();
  }

  pay(opts: { to: string; lamports: number; reference?: string; ok?: boolean; from?: string }) {
    const from = opts.from ?? Keypair.generate().publicKey.toBase58();
    const ok = opts.ok ?? true;
    const keys = [from, opts.to, '11111111111111111111111111111111', ...(opts.reference ? [opts.reference] : [])];
    const signature = this.sig();
    this.txs.set(signature, { signature, ok, accountKeys: keys, deltas: ok ? [-opts.lamports - 5000, opts.lamports, 0, 0] : [-5000, 0, 0, 0], feePayer: from, blockTime: Math.floor(Date.now() / 1000) });
    if (ok) this.balances.set(opts.to, (this.balances.get(opts.to) ?? 0) + opts.lamports);
    return signature;
  }

  async getTransfer(signature: string) {
    return this.txs.get(signature) ?? null;
  }
  async findSignatureByReference(reference: string) {
    for (const t of this.txs.values()) if (t.ok && t.accountKeys.includes(reference)) return t.signature;
    return null;
  }
  async getBalance(publicKey: string) {
    return this.balances.get(publicKey) ?? 0;
  }
  async transfer(secretKey: Uint8Array, destination: string, lamports: number) {
    const from = Keypair.fromSecretKey(secretKey).publicKey.toBase58();
    const bal = this.balances.get(from) ?? 0;
    if (lamports + this.feeLamports > bal) throw new Error('insufficient lamports');
    this.balances.set(from, bal - lamports - this.feeLamports);
    this.balances.set(destination, (this.balances.get(destination) ?? 0) + lamports);
    return this.pay({ to: destination, lamports: 0, from });
  }
}

const ledger = new FakeLedger();
const key = randomBytes(32);
let srv: TestServer;

beforeAll(async () => {
  srv = await startServer(
    (c) => {
      c.solana.enabled = true;
      c.solana.encryptionKey = key;
    },
    { solanaGateway: ledger },
  );
});
afterAll(async () => srv?.close());

async function setupDonations() {
  const owner = await registerUser(srv.base, 'Owner');
  const g = await createGallery(owner.api);
  const on = await owner.api.put(`/v1/galleries/${g.id}/donations`, { enabled: true, message: 'Support the artists' });
  expect(on.status).toBe(200);
  return { owner, g, address: on.body.address as string };
}

describe('donations (custodial gallery wallet, no goal)', () => {
  it('owner enables donations: a wallet is created and its secret is only stored encrypted', async () => {
    const { g, address } = await setupDonations();
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const { rows } = await srv.db.query(`SELECT encrypted_secret, public_key FROM donation_wallets WHERE gallery_id = $1`, [g.id]);
    const secret = decryptSecret(key, rows[0].encrypted_secret, `${g.id}:${address}`);
    expect(Keypair.fromSecretKey(secret).publicKey.toBase58()).toBe(address);
    // Bound to its row: decrypting with another gallery ID fails.
    expect(() => decryptSecret(key, rows[0].encrypted_secret, `${randomUUID()}:${address}`)).toThrow();
    // No API response contains secret material.
    const info = await client(srv.base).get('/v1/capabilities');
    expect(info.body.features.donations).toBe(true);
    expect(JSON.stringify(info.body)).not.toContain(Buffer.from(secret).toString('base64'));
  });

  it('counts a donation only after on-chain verification, once, and pushes it live', async () => {
    const { owner, g, address } = await setupDonations();
    await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'view_link' });
    const link = new URL((await owner.api.get(`/v1/galleries/${g.id}/sharing`)).body.viewUrl).searchParams.get('link')!;
    const visitor = client(srv.base, undefined, { 'x-gallery-link': link }); // anonymous link viewer
    const live = await connectAndSync(owner.api, g.id, 'view');

    const intent = await visitor.post(`/v1/galleries/${g.id}/donations/intents`, { lamports: 50_000_000, donorName: 'Marie', message: 'Bèl travay!' });
    expect(intent.status).toBe(201);
    expect(intent.body).toMatchObject({ status: 'pending', recipient: address, requestedLamports: 50_000_000 });
    expect(intent.body.solanaPayUrl).toMatch(new RegExp(`^solana:${address}\\?amount=0\\.05&reference=${intent.body.reference}`));

    // Fabricated / wrong transactions are rejected.
    const bogus = await visitor.post(`/v1/donations/${intent.body.id}/confirm`, { signature: ledger.pay({ to: address, lamports: 50_000_000 }) });
    expect(bogus.body.error).toMatchObject({ code: 'DONATION_UNVERIFIED', details: { reason: 'reference_missing' } });
    const tooLow = await visitor.post(`/v1/donations/${intent.body.id}/confirm`, { signature: ledger.pay({ to: address, lamports: 1_000_000, reference: intent.body.reference }) });
    expect(tooLow.body.error.details.reason).toBe('amount_too_low');
    const failed = await visitor.post(`/v1/donations/${intent.body.id}/confirm`, { signature: ledger.pay({ to: address, lamports: 50_000_000, reference: intent.body.reference, ok: false }) });
    expect(failed.body.error.details.reason).toBe('transaction_failed');
    const unknown = await visitor.post(`/v1/donations/${intent.body.id}/confirm`, { signature: Keypair.generate().publicKey.toBase58().repeat(2) });
    expect(unknown.body.error.details).toMatchObject({ reason: 'not_found_yet', retryable: true });

    const sig = ledger.pay({ to: address, lamports: 50_000_000, reference: intent.body.reference });
    const ok = await visitor.post(`/v1/donations/${intent.body.id}/confirm`, { signature: sig });
    expect(ok.body).toMatchObject({ status: 'confirmed', donation: { lamports: 50_000_000, sol: '0.05', donorName: 'Marie', message: 'Bèl travay!' } });
    expect((await visitor.post(`/v1/donations/${intent.body.id}/confirm`, { signature: sig })).body.status).toBe('confirmed'); // idempotent

    // The same signature cannot be counted for a second intent.
    const second = await visitor.post(`/v1/galleries/${g.id}/donations/intents`, {});
    expect((await visitor.post(`/v1/donations/${second.body.id}/confirm`, { signature: sig })).body.error.details.reason).toBe('reference_missing');

    const ev = await live.waitFor((m) => m.type === 'donation');
    expect(ev.summary).toMatchObject({ totalLamports: 50_000_000, donationCount: 1 });
    const summary = (await visitor.get(`/v1/galleries/${g.id}/donations`)).body;
    expect(summary).toMatchObject({ enabled: true, totalSol: '0.05', donationCount: 1, message: 'Support the artists' });
    expect(summary).not.toHaveProperty('goal');
    live.close();
  });

  it('the background poller finds donations the browser never reported', async () => {
    const { owner, g, address } = await setupDonations();
    const intent = await owner.api.post(`/v1/galleries/${g.id}/donations/intents`, {});
    ledger.pay({ to: address, lamports: 20_000_000, reference: intent.body.reference });
    expect(await srv.app.deps.donations.pollPending()).toBeGreaterThanOrEqual(1);
    expect((await owner.api.get(`/v1/donations/${intent.body.id}`)).body).toMatchObject({ status: 'confirmed', donation: { lamports: 20_000_000, donorName: null } });
  });

  it('only the owner withdraws, with their password, idempotently, within the balance', async () => {
    const { owner, g, address } = await setupDonations();
    const editor = await registerUser(srv.base, 'Editor');
    await addMember(srv.db, g.id, editor.id, 'editor');
    const intent = await owner.api.post(`/v1/galleries/${g.id}/donations/intents`, {});
    await owner.api.post(`/v1/donations/${intent.body.id}/confirm`, { signature: ledger.pay({ to: address, lamports: 300_000_000, reference: intent.body.reference }) });
    const dest = Keypair.generate().publicKey.toBase58();
    const body = { requestId: randomUUID(), destination: dest, lamports: 100_000_000, password: 'correct-horse-1' };

    expect((await editor.api.post(`/v1/galleries/${g.id}/donations/withdrawals`, body)).status).toBe(403);
    expect((await editor.api.get(`/v1/galleries/${g.id}/donations/wallet`)).status).toBe(403);
    expect((await owner.api.post(`/v1/galleries/${g.id}/donations/withdrawals`, { ...body, password: 'wrong-password' })).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await owner.api.post(`/v1/galleries/${g.id}/donations/withdrawals`, { ...body, destination: 'not-an-address' })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await owner.api.post(`/v1/galleries/${g.id}/donations/withdrawals`, { ...body, requestId: randomUUID(), lamports: 10_000_000_000 })).body.error.code).toBe('INSUFFICIENT_FUNDS');

    const w1 = await owner.api.post(`/v1/galleries/${g.id}/donations/withdrawals`, body);
    expect(w1.body).toMatchObject({ status: 'confirmed', lamports: 100_000_000, destination: dest, duplicate: false });
    const w2 = await owner.api.post(`/v1/galleries/${g.id}/donations/withdrawals`, body);
    expect(w2.body).toMatchObject({ id: w1.body.id, duplicate: true });
    expect(ledger.balances.get(dest)).toBe(100_000_000); // sent once

    const all = await owner.api.post(`/v1/galleries/${g.id}/donations/withdrawals`, { ...body, requestId: randomUUID(), lamports: 'all' });
    expect(all.body.status).toBe('confirmed');
    const wallet = (await owner.api.get(`/v1/galleries/${g.id}/donations/wallet`)).body;
    expect(wallet.balanceLamports).toBe(0);
    expect(wallet.withdrawals).toHaveLength(2);
  });

  it('respects gallery access: restricted galleries hide the donation button from outsiders', async () => {
    const { g } = await setupDonations();
    const outsider = await registerUser(srv.base, 'Outsider');
    expect((await outsider.api.get(`/v1/galleries/${g.id}/donations`)).status).toBe(404);
    expect((await outsider.api.post(`/v1/galleries/${g.id}/donations/intents`, {})).status).toBe(404);
  });
});

describe('donations disabled', () => {
  it('returns 404 and reports the feature off', async () => {
    const off = await startServer();
    try {
      const owner = await registerUser(off.base, 'Owner');
      const g = await createGallery(owner.api);
      expect((await owner.api.put(`/v1/galleries/${g.id}/donations`, { enabled: true })).status).toBe(404);
      expect((await client(off.base).get('/v1/capabilities')).body.features.donations).toBe(false);
    } finally {
      await off.close();
    }
  });
});
