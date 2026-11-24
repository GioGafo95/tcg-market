// Almacenamiento de archivos (fotos de vendedores e imágenes oficiales cacheadas).
//  - local: carpeta ./uploads, servida como estático en /uploads/...
//  - aws:   bucket S3 privado; /uploads/<key> redirige a una URL firmada temporal.
// En ambos casos la URL pública de un archivo es "/uploads/<key>".
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MODE = process.env.STORAGE === 'aws' ? 'aws' : 'local';
export const publicUrl = key => `/uploads/${key}`;

let s3, cmds, presign;
async function aws() {
  if (!s3) {
    const sdk = await import('@aws-sdk/client-s3');
    ({ getSignedUrl: presign } = await import('@aws-sdk/s3-request-presigner'));
    s3 = new sdk.S3Client({});
    cmds = sdk;
  }
  return { s3, ...cmds };
}
const BUCKET = process.env.BUCKET_NAME;

export async function putFile(key, buffer, contentType) {
  if (MODE === 'local') {
    const path = join('uploads', key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buffer);
    return;
  }
  const { s3, PutObjectCommand } = await aws();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

export async function fileExists(key) {
  if (MODE === 'local') return existsSync(join('uploads', key));
  const { s3, HeadObjectCommand } = await aws();
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

export async function deleteFile(key) {
  try {
    if (MODE === 'local') return unlinkSync(join('uploads', key));
    const { s3, DeleteObjectCommand } = await aws();
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch { /* ya no existe */ }
}

// Middleware para /uploads
export function uploadsHandler(express) {
  if (MODE === 'local') {
    return express.static('uploads', { setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') });
  }
  return async (req, res, next) => {
    const key = decodeURIComponent(req.path.replace(/^\//, ''));
    if (!/^(photos|ref)\/[\w.-]+$/.test(key)) return res.status(404).end();
    try {
      const { s3, GetObjectCommand } = await aws();
      const url = await presign(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
      res.setHeader('Cache-Control', 'private, max-age=3000');
      res.redirect(302, url);
    } catch (err) { next(err); }
  };
}
