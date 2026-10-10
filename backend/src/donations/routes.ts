import { Type } from 'typebox';
import type { App } from '../app.js';
import { requireAccess } from '../galleries/access.js';
import { principalFor, requireUser } from '../http/context.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { ErrorResponse, GalleryIdParams } from '../schemas/api.js';
import { renderQr } from '../sharing/links.js';

const DonationParams = Type.Object({ donationId: Type.String({ format: 'uuid' }) });

export async function donationRoutes(app: App) {
  const { db, donations } = app.deps;
  const intentLimiter = new RateLimiter(20, 60_000);

  async function viewableDonation(req: any) {
    const row = await donations.getIntent(req.params.donationId);
    await requireAccess(db, row.gallery_id, principalFor(req, row.gallery_id), 'view');
    return row;
  }

  app.get(
    '/v1/galleries/:galleryId/donations',
    {
      schema: {
        tags: ['donations'],
        summary: 'Donation button state: wallet address, total donated, recent donors (anyone who can view)',
        description: 'There is no fundraising goal. 404 when donations are disabled on this server.',
        params: GalleryIdParams,
      },
    },
    async (req) => {
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'view');
      return donations.publicInfo(req.params.galleryId);
    },
  );

  app.put(
    '/v1/galleries/:galleryId/donations',
    {
      schema: {
        tags: ['donations'],
        summary: 'Turn the donation button on/off and set its message (owner)',
        description: 'The first time donations are enabled, the server creates the gallery\'s custodial wallet. Its private key is never returned.',
        params: GalleryIdParams,
        body: Type.Object({ enabled: Type.Boolean(), message: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false }),
      },
    },
    async (req) => {
      requireUser(req);
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'manage');
      return donations.configure(req.params.galleryId, req.body);
    },
  );

  app.post(
    '/v1/galleries/:galleryId/donations/intents',
    {
      schema: {
        tags: ['donations'],
        summary: 'Start a donation: returns the recipient, a unique reference key and a Solana Pay link',
        description:
          'Browser wallets: build a SystemProgram.transfer to `recipient` and add `reference` as a read-only, non-signer account key, then POST the signature to /v1/donations/{id}/confirm. Mobile wallets: show the Solana Pay QR (/v1/donations/{id}/qr). Either way the server verifies the transaction on-chain before counting it.',
        params: GalleryIdParams,
        body: Type.Object(
          {
            lamports: Type.Optional(Type.Integer({ minimum: 1, maximum: 1e15, description: '1 SOL = 1,000,000,000 lamports. Omit to let the donor choose in their wallet.' })),
            donorName: Type.Optional(Type.String({ maxLength: 60, description: 'Shown publicly; omit to stay anonymous.' })),
            message: Type.Optional(Type.String({ maxLength: 280 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Unknown(), 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'view');
      if (!intentLimiter.take(`${req.ip}:${req.params.galleryId}`)) throw new AppError('RATE_LIMITED');
      const { rows } = await db.query(`SELECT title FROM galleries WHERE id = $1`, [req.params.galleryId]);
      const donorUserId = req.caller.kind === 'user' ? req.caller.userId : null;
      reply.code(201);
      return donations.createIntent(req.params.galleryId, { ...req.body, donorUserId, label: rows[0].title });
    },
  );

  app.get(
    '/v1/donations/:donationId',
    { schema: { tags: ['donations'], summary: 'Donation status (pending | confirmed | expired)', params: DonationParams } },
    async (req) => donations.view(await viewableDonation(req)),
  );

  app.post(
    '/v1/donations/:donationId/confirm',
    {
      schema: {
        tags: ['donations'],
        summary: 'Report the transaction signature; the server verifies it on-chain',
        description:
          '422 DONATION_UNVERIFIED with details.reason: not_found_yet (retryable: retry every few seconds), transaction_failed, reference_missing, wallet_not_credited, amount_too_low, signature_already_counted. Unreported donations are also found by a background poller.',
        params: DonationParams,
        body: Type.Object({ signature: Type.String({ maxLength: 100 }) }, { additionalProperties: false }),
      },
    },
    async (req) => {
      await viewableDonation(req);
      return donations.confirm(req.params.donationId, req.body.signature);
    },
  );

  app.get(
    '/v1/donations/:donationId/qr',
    {
      schema: {
        tags: ['donations'],
        summary: 'Solana Pay QR code (PNG/SVG) for a pending donation',
        params: DonationParams,
        querystring: Type.Object({
          format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('svg')], { default: 'png' })),
          size: Type.Optional(Type.Integer({ minimum: 128, maximum: 1024, default: 512 })),
        }),
      },
    },
    async (req, reply) => {
      const view = donations.view(await viewableDonation(req));
      const format = req.query.format ?? 'png';
      reply.header('x-link-url', view.solanaPayUrl).header('cache-control', 'no-store').type(format === 'svg' ? 'image/svg+xml' : 'image/png');
      return reply.send(await renderQr(view.solanaPayUrl, format, req.query.size ?? 512));
    },
  );

  app.get(
    '/v1/galleries/:galleryId/donations/wallet',
    { schema: { tags: ['donations'], summary: 'Wallet balance and withdrawal history (owner)', params: GalleryIdParams } },
    async (req) => {
      requireUser(req);
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'manage');
      return donations.walletInfo(req.params.galleryId);
    },
  );

  app.post(
    '/v1/galleries/:galleryId/donations/withdrawals',
    {
      schema: {
        tags: ['donations'],
        summary: 'Withdraw donated funds to a wallet address (owner, password required)',
        description:
          'Signs and sends a transfer from the gallery wallet. lamports "all" sends the balance minus the network fee. Retrying with the same requestId returns the original withdrawal (never sends twice). Irreversible once confirmed.',
        params: GalleryIdParams,
        body: Type.Object(
          {
            requestId: Type.String({ minLength: 8, maxLength: 100 }),
            destination: Type.String({ maxLength: 60 }),
            lamports: Type.Union([Type.Integer({ minimum: 1 }), Type.Literal('all')]),
            password: Type.String({ maxLength: 200, description: "The owner's account password, re-entered." }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { userId } = requireUser(req);
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'manage');
      return donations.withdraw(req.params.galleryId, userId, req.body);
    },
  );
}
