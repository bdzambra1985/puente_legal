'use strict';
const sharp = require('sharp');
const { spawn } = require('child_process');
const cloudinary = require('cloudinary').v2;

/* ── PDF → JPEG (primera página) ──────────────────────────────────────
   Los PDF no se renderizan de forma confiable en el visor del panel
   admin (embebidos en un iframe con blob:), así que al subirse se
   rasteriza su primera página a una imagen JPEG con poppler
   (`pdftocairo`, instalado en el Dockerfile vía `poppler-utils`). Lee
   el PDF por stdin y escribe el JPEG por stdout — sin archivos temporales. */
function pdfToJpeg(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pdftocairo', ['-jpeg', '-singlefile', '-scale-to', '1600', '-', '-']);
    const out = [], err = [];
    proc.stdout.on('data', c => out.push(c));
    proc.stderr.on('data', c => err.push(c));
    proc.on('error', reject); // p.ej. el binario no está instalado
    proc.on('close', code => {
      const buf = Buffer.concat(out);
      if (code !== 0 || !buf.length)
        return reject(new Error('pdftocairo falló: ' + Buffer.concat(err).toString().slice(0, 200)));
      resolve(buf);
    });
    proc.stdin.on('error', () => {}); // evita un EPIPE si el proceso cierra antes
    proc.stdin.write(pdfBuffer);
    proc.stdin.end();
  });
}

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
  // Un PDF se convierte a JPEG (primera página) para que siempre se pueda
  // ver como imagen en el panel. Si la conversión falla (poppler ausente
  // en dev, o PDF corrupto), se guarda el PDF tal cual — no se pierde el
  // comprobante, y el admin igual puede abrirlo con "Abrir en nueva pestaña".
  if (ext === '.pdf') {
    try {
      buffer = await pdfToJpeg(buffer);
      ext = '.jpg';
    } catch (e) {
      console.warn('[upload] No se pudo convertir PDF a imagen, se guarda como PDF:', e.message);
    }
  }
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
