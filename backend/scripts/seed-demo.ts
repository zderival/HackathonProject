// Explicit development/demo seed: `npm run seed:demo`.
//
// Creates owner/editor/viewer accounts and a furnished demo gallery whose artwork is
// generated here (original procedural images, no third-party content). Everything goes
// through the real services (upload pipeline, scene operations), so the result is exactly
// what the API would produce.
//
// Passwords: DEMO_PASSWORD if set, otherwise a random password per run (printed once).
// There is no fixed default password. Refuses to run with NODE_ENV=production unless
// --allow-production is passed.
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ActionService } from '../src/actions/service.js';
import { AssetService } from '../src/assets/service.js';
import { S3Storage } from '../src/assets/storage.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword, randomToken } from '../src/lib/crypto.js';
import { SCENE_SCHEMA_VERSION } from '../src/schemas/scene.js';
import { starterScene, yawQuat } from '../src/scene/defaults.js';
import { qMul, qNormalize, type Q } from '../src/scene/math.js';
import { galleryLink, editJoinLink } from '../src/sharing/links.js';

const config = loadConfig();
if (config.nodeEnv === 'production' && !process.argv.includes('--allow-production')) {
  console.error('Refusing to seed demo accounts with NODE_ENV=production (pass --allow-production to override).');
  process.exit(1);
}

const domain = process.env.DEMO_EMAIL_DOMAIN ?? 'demo.gallery.test';
const password = process.env.DEMO_PASSWORD || `demo-${randomBytes(9).toString('base64url')}`;
if (password.length < 8) throw new Error('DEMO_PASSWORD must be at least 8 characters');

const ACCOUNTS = [
  { key: 'owner', name: 'Ada (owner)', lang: 'en' },
  { key: 'editor', name: 'Jean (editor)', lang: 'ht' },
  { key: 'editor2', name: 'Min-ji (editor)', lang: 'ko' },
  { key: 'viewer', name: 'Lucía (viewer)', lang: 'es' },
] as const;

// Original abstract artworks generated from SVG.
function artworkSvg(seed: number, w: number, h: number): string {
  const rnd = (() => {
    let s = seed;
    return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  })();
  const palettes = [
    ['#1d3557', '#457b9d', '#a8dadc', '#f1faee', '#e63946'],
    ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c', '#d90429'],
    ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
    ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
  ];
  const p = palettes[seed % palettes.length];
  let shapes = '';
  for (let i = 0; i < 18; i++) {
    const c = p[Math.floor(rnd() * p.length)];
    const x = rnd() * w;
    const y = rnd() * h;
    const r = 20 + rnd() * Math.min(w, h) * 0.3;
    shapes +=
      rnd() > 0.5
        ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}" opacity="${(0.5 + rnd() * 0.5).toFixed(2)}"/>`
        : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(r * 1.6).toFixed(1)}" height="${(r * 0.8).toFixed(1)}" fill="${c}" opacity="${(0.5 + rnd() * 0.5).toFixed(2)}" transform="rotate(${(rnd() * 90 - 45).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${p[3]}"/>${shapes}</svg>`;
}

const aim = (yaw: number, pitch: number) =>
  qNormalize(qMul(yawQuat(yaw) as Q, [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)])).map((v) => Math.round(v * 1e8) / 1e8);

async function main() {
  await migrate(config.databaseUrl, config.databaseSsl, (m) => console.log(m));
  const db = createPool(config.databaseUrl, config.databaseSsl);
  const storage = new S3Storage(config.s3);
  if (config.s3.createBucket) await storage.ensureBucket();
  const assets = new AssetService(db, storage, config);
  // No live connections during seeding; nothing to broadcast.
  const actions = new ActionService(db, config, { publish: () => {} });

  const users: Record<string, { id: string; email: string }> = {};
  const hash = await hashPassword(password);
  for (const a of ACCOUNTS) {
    const email = `${a.key}@${domain}`;
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, display_name, preferred_language) VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
      [email, hash, a.name, a.lang],
    );
    users[a.key] = { id: rows[0].id, email };
  }
  // Seeding resets passwords: end old sessions so only the printed password works.
  await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [Object.values(users).map((u) => u.id)]);

  const title = 'Demo Gallery';
  const { rows: g } = await db.query(
    `INSERT INTO galleries (owner_id, title, description, scene, schema_version, sharing_mode, view_link_token, edit_link_token)
     VALUES ($1, $2, $3, $4, $5, 'view_link', $6, $7) RETURNING id`,
    [users.owner.id, title, 'Seeded demo: a furnished room with three original artworks.', starterScene({ title: 'Welcome to the Demo Gallery' }), SCENE_SCHEMA_VERSION, randomToken('gv', 18), randomToken('ge', 18)],
  );
  const galleryId = g[0].id as string;
  for (const [key, role] of [['editor', 'editor'], ['editor2', 'editor'], ['viewer', 'viewer']] as const)
    await db.query(`INSERT INTO gallery_members (gallery_id, user_id, role, source) VALUES ($1, $2, $3, 'direct')`, [galleryId, users[key].id, role]);

  const artworks = [
    { title: 'Harbor Lights', w: 1600, h: 1200, seed: 7, attribution: 'Generated for the demo seed' },
    { title: 'Quiet Geometry', w: 1200, h: 1600, seed: 21, attribution: 'Generated for the demo seed' },
    { title: 'Sunset Study', w: 1800, h: 1000, seed: 42, attribution: 'Generated for the demo seed' },
  ];
  const uploaded = [];
  for (const a of artworks) {
    const png = await sharp(Buffer.from(artworkSvg(a.seed, a.w, a.h))).png().toBuffer();
    uploaded.push(await assets.upload(galleryId, users.owner.id, png, { title: a.title, description: `${a.title}, an abstract composition.`, attribution: a.attribution }));
  }

  const principal = { userId: users.owner.id };
  const commit = async (label: string, ops: any[]) => {
    const { rows } = await db.query(`SELECT revision FROM galleries WHERE id = $1`, [galleryId]);
    return actions.commit({ galleryId, principal, source: 'system', requestId: randomUUID(), baseRevision: rows[0].revision, conflictMode: 'strict', label, ops });
  };

  await commit('Hang seed artworks', [
    { op: 'artwork.place', nodeId: 'art-harbor', assetId: uploaded[0].id, parentId: 'wall-north', width: 1.6 },
    { op: 'artwork.hangOnWall', nodeId: 'art-harbor', wallId: 'wall-north', x: -2.2, centerHeight: 1.6 },
    { op: 'artwork.place', nodeId: 'art-geometry', assetId: uploaded[1].id, parentId: 'wall-west', width: 1.0 },
    { op: 'artwork.hangOnWall', nodeId: 'art-geometry', wallId: 'wall-west', x: 0, centerHeight: 1.6 },
    { op: 'artwork.place', nodeId: 'art-sunset', assetId: uploaded[2].id, parentId: 'wall-east', width: 1.8 },
    { op: 'artwork.hangOnWall', nodeId: 'art-sunset', wallId: 'wall-east', x: 0.5, centerHeight: 1.6 },
    { op: 'artwork.setFrame', nodeId: 'art-geometry', frame: { style: 'modern', color: '#111111', matWidth: 0.06 } },
  ]);
  await commit('Furnish and light the room', [
    { op: 'node.update', nodeId: 'label-welcome', set: { 'transform.position': [2.2, 0.2, 0.09] } },
    { op: 'node.add', node: { id: 'bench', type: 'primitive', name: 'Bench', parentId: 'room-main', transform: { position: [0, 0.225, 0.5] }, props: { shape: 'box', size: [1.8, 0.45, 0.5], material: { color: '#5b4636', roughness: 0.6 } } } },
    { op: 'node.add', node: { id: 'pedestal', type: 'primitive', name: 'Pedestal', parentId: 'room-main', transform: { position: [3, 0.5, -2] }, props: { shape: 'cylinder', size: [0.6, 1, 0.6], material: { color: '#eeeeee' } } } },
    { op: 'node.add', node: { id: 'sculpture', type: 'primitive', name: 'Sculpture', parentId: 'pedestal', transform: { position: [0, 0.75, 0] }, props: { shape: 'torus', size: [0.45, 0.45, 0.15], material: { color: '#c9a227', metalness: 0.9, roughness: 0.25 } } } },
    { op: 'node.add', node: { id: 'label-harbor', type: 'text', name: 'Harbor Lights label', parentId: 'wall-north', transform: { position: [-1.0, -0.25, 0.09] }, props: { text: 'Harbor Lights', fontSize: 0.06, align: 'left' } } },
    ...['north', 'west', 'east'].map((w, i) => ({
      op: 'node.add',
      node: {
        id: `spot-${w}`,
        type: 'light',
        name: `Spotlight (${w})`,
        parentId: 'room-main',
        // Spot lights shine along local -Z: yaw toward the wall, then pitch down 35 degrees.
        transform: { position: [[-2.2, 2.8, -2.6], [-3.6, 2.8, 0], [3.6, 2.8, 0.5]][i], rotation: aim([0, Math.PI / 2, -Math.PI / 2][i], -0.6) },
        props: { lightType: 'spot', color: '#fff1d6', intensity: 2, range: 8, angle: 0.5, penumbra: 0.4 },
      },
    })),
    { op: 'scene.setEnvironment', environment: { ambientIntensity: 0.5, skybox: 'studio' } },
    { op: 'scene.setViewerAnchor', position: [0, 1.6, 2.5], rotation: [0, 0, 0, 1], roomId: 'room-main' },
  ]);

  const { rows: links } = await db.query(`SELECT view_link_token, edit_link_token, revision FROM galleries WHERE id = $1`, [galleryId]);
  console.log('\n=== Demo seed complete ===');
  console.log(`Gallery:   ${title} (${galleryId}), revision ${links[0].revision}`);
  console.log(`Password for all demo accounts (shown once): ${password}`);
  for (const a of ACCOUNTS) console.log(`  ${a.key.padEnd(8)} ${users[a.key].email}  [${a.lang}]`);
  console.log(`View link (QR): ${galleryLink(config, galleryId, links[0].view_link_token)}`);
  console.log(`Edit join link (enable with sharing mode edit_link): ${editJoinLink(config, galleryId, links[0].edit_link_token)}`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
