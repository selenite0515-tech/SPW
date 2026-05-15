const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const NODE_ENV = process.env.NODE_ENV || 'development';

function s3EnvKeysPresent() {
  return Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_REGION &&
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY
  );
}

/**
 * In production, PDFs must use S3-compatible object storage when deployed for real use.
 * In development, missing S3 env falls back to local disk under PDF_STORAGE_DIR.
 */
function assertProductionPdfStorageConfigured() {
  if (NODE_ENV !== 'production') return;
  if (!s3EnvKeysPresent()) {
    const err = new Error(
      'NODE_ENV=production requires S3-compatible storage: set S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (and typically S3_FORCE_PATH_STYLE=true for MinIO).'
    );
    err.code = 'S3_CONFIG_INCOMPLETE';
    throw err;
  }
}

function normalizePrefix(raw) {
  const p = (raw || 'payslips').replace(/\\/g, '/').trim();
  if (!p) return 'payslips/';
  return p.endsWith('/') ? p : `${p}/`;
}

function payslipBasename(employeeId, year, month) {
  return `emp_${employeeId}_${year}_${month}.pdf`;
}

/** Object key inside the bucket (includes prefix). */
function s3ObjectKeyForBasename(basename) {
  const prefix = normalizePrefix(process.env.S3_KEY_PREFIX);
  return `${prefix}${basename}`;
}

function createS3Client() {
  if (!s3EnvKeysPresent()) return null;
  const forcePathStyle =
    process.env.S3_FORCE_PATH_STYLE === 'true' ||
    process.env.S3_FORCE_PATH_STYLE === '1' ||
    process.env.S3_FORCE_PATH_STYLE === 'yes';

  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle,
  });
}

function getBucket() {
  return process.env.S3_BUCKET;
}

/**
 * @returns {{ mode: 's3', client: import('@aws-sdk/client-s3').S3Client } | { mode: 'local' }}
 */
function getPdfStorageMode() {
  const client = createS3Client();
  if (client) return { mode: 's3', client };
  return { mode: 'local' };
}

function pdfStorageRoot(projectRoot) {
  if (process.env.PDF_STORAGE_DIR) {
    return path.resolve(process.env.PDF_STORAGE_DIR);
  }
  return path.join(projectRoot, 'data', 'pdfs');
}

function resolveLocalPdfPath(projectRoot, basename) {
  if (!basename || typeof basename !== 'string') return null;
  const safeName = path.basename(basename);
  if (safeName !== basename || !/^emp_\d+_\d{4}_\d{1,2}\.pdf$/.test(safeName)) {
    return null;
  }
  return path.join(pdfStorageRoot(projectRoot), safeName);
}

/**
 * @param {import('@aws-sdk/client-s3').S3Client} client
 * @param {string} objectKey
 * @param {string} filePath
 */
async function putFileToS3(client, objectKey, filePath) {
  const body = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: objectKey,
      Body: body,
      ContentType: 'application/pdf',
    })
  );
  return { sha256, byteLength: body.length };
}

async function presignedPdfGetUrl(client, objectKey, expiresInSeconds) {
  const cmd = new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
}

/**
 * @param {import('@aws-sdk/client-s3').S3Client} client
 * @param {string} objectKey
 * @returns {Promise<NodeJS.ReadableStream>}
 */
async function getObjectBodyStream(client, objectKey) {
  const out = await client.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: objectKey,
    })
  );
  if (!out.Body) {
    throw new Error('S3 GetObject returned empty body');
  }
  return /** @type {NodeJS.ReadableStream} */ (out.Body);
}

module.exports = {
  assertProductionPdfStorageConfigured,
  s3EnvKeysPresent,
  payslipBasename,
  s3ObjectKeyForBasename,
  getPdfStorageMode,
  pdfStorageRoot,
  resolveLocalPdfPath,
  putFileToS3,
  presignedPdfGetUrl,
  getObjectBodyStream,
};
