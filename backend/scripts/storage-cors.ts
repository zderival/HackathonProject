// `npm run storage:cors` - lets browsers load signed asset/speech URLs from the bucket
// (needed for WebGL textures, which are fetched with CORS). Allows GET/HEAD from
// CORS_ORIGINS only. Native iOS/Unity clients do not need CORS.
import { PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
await s3.send(
  new PutBucketCorsCommand({
    Bucket: config.s3.bucket,
    CORSConfiguration: {
      CORSRules: [{ AllowedOrigins: config.corsOrigins, AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], MaxAgeSeconds: 3600 }],
    },
  }),
);
console.log(`CORS set on bucket ${config.s3.bucket} for ${config.corsOrigins.join(', ')}`);
