'use strict';
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;

/* ── Cloudinary (opcional) ──────────────────────────────────────────── */
const CLD_URL    = process.env.CLOUDINARY_URL;
const CLD_NAME   = process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_NAME;
const CLD_KEY    = process.env.CLOUDINARY_API_KEY    || process.env.CLOUDINARY_KEY;
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_SECRET;
const USE_CLOUDINARY = !!(CLD_URL || (CLD_NAME && CLD_KEY && CLD_SECRET));

// Si CLOUDINARY_URL está seteada, el SDK ya se auto-configura solo al cargarse
// (lee esa variable de entorno). Solo hace falta configurar a mano si se usan
// las variables separadas (cloud name / key / secret).
if (USE_CLOUDINARY && !CLD_URL) {
  cloudinary.config({ cloud_name: CLD_NAME, api_key: CLD_KEY, api_secret: CLD_SECRET });
}

/* ── Compresión de imágenes ───────────────────────────────────────────
   Reduce dimensión y calidad al máximo razonable para un comprobante de
   pago (sigue siendo legible). PDFs se guardan tal cual — sharp no
   procesa PDFs y no hay forma liviana de recomprimirlos aquí. */
const MAX_DIM     = 1600;
const IMG_QUALITY = 70;

async function compressImage(buffer, ext) {
  if (ext === '.pdf') return { buffer, ext: '.pdf' };

  const pipeline = sharp(buffer)
    .rotate() // corrige orientación EXIF
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true });

  const compressed = ext === '.png'
    ? await pipeline.png({ quality: IMG_QUALITY, compressionLevel: 9 }).toBuffer()
    : await pipeline.jpeg({ quality: IMG_QUALITY, progressive: true }).toBuffer();

  const outExt = ext === '.png' ? '.png' : '.jpg';
  const before = Math.round(buffer.length / 1024);
  const after  = Math.round(compressed.length / 1024);
  console.log(`  [IMG] ${before}KB → ${after}KB (ahorro: ${Math.round((1 - after / before) * 100)}%)`);

  return { buffer: compressed, ext: outExt };
}

/* ── Subida (Cloudinary si está configurado, si no disco local) ──────
   Devuelve { path, isUrl } — path es la URL de Cloudinary o el nombre
   de archivo local; isUrl indica cuál de los dos es. */
async function saveComprobante(buffer, ext, citaId, localDir) {
  const { buffer: outBuffer, ext: outExt } = await compressImage(buffer, ext);

  if (USE_CLOUDINARY) {
    // Entrega autenticada: el asset NO es accesible por URL pública. Se guarda
    // un marcador `cld:<resource_type>:<public_id>` y el panel admin genera una
    // URL firmada de corta duración al momento de servirlo (ver routes/admin.js).
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'puente-legal/comprobantes', resource_type: 'auto', type: 'authenticated' },
        (err, result) => err ? reject(new Error(err.message || JSON.stringify(err))) : resolve(result)
      ).end(outBuffer);
    });
    return { path: `cld:${result.resource_type}:${result.public_id}`, isUrl: false };
  }

  const fs = require('fs');
  const path = require('path');
  const filename = `cita-${citaId}-${Date.now()}${outExt}`;
  fs.writeFileSync(path.join(localDir, filename), outBuffer, { mode: 0o600 });
  return { path: filename, isUrl: false };
}

module.exports = { USE_CLOUDINARY, compressImage, saveComprobante };
