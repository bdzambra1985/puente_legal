const nodemailer = require('nodemailer');

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendCitaConfirmada(cita) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log('[email] SMTP no configurado — skipping cita id:', cita.id);
    return;
  }

  const esZoom = cita.contacto_tipo === 'zoom';
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  const contactoBloque = esZoom
    ? `<div style="background:#eef2ff;border-radius:10px;padding:22px;margin:24px 0;text-align:center">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1.5px;color:#4f46e5;font-weight:800;margin-bottom:10px">Enlace de Zoom</div>
        <a href="${escHtml(cita.zoom_link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:13px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:.9rem;word-break:break-all">${escHtml(cita.zoom_link)}</a>
        <div style="font-size:.75rem;color:#6b7280;margin-top:10px">Haz clic en el enlace a la hora de tu cita</div>
      </div>`
    : `<div style="background:#f0fdf4;border-radius:10px;padding:22px;margin:24px 0;text-align:center">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1.5px;color:#16a34a;font-weight:800;margin-bottom:10px">WhatsApp</div>
        <div style="font-size:1.15rem;font-weight:700;color:#0f1e38;letter-spacing:.5px">${escHtml(cita.contacto_valor)}</div>
        <div style="font-size:.75rem;color:#6b7280;margin-top:8px">Te contactaremos en este número a la hora de tu cita</div>
      </div>`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:#f8f7f4;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:#0f1e38;padding:32px 40px;text-align:center">
      <div style="font-size:1.3rem;font-weight:800;color:#C9A227;letter-spacing:2px">PUENTE LEGAL</div>
      <div style="font-size:.7rem;color:rgba(255,255,255,.35);margin-top:4px;letter-spacing:1px">INTERNACIONAL EC</div>
    </div>
    <div style="padding:36px 40px">
      <div style="text-align:center;margin-bottom:28px">
        <div style="font-size:2.8rem;margin-bottom:12px">✅</div>
        <h1 style="font-size:1.25rem;color:#0f1e38;margin:0 0 8px;font-weight:700">¡Tu cita ha sido confirmada!</h1>
        <p style="color:#64748b;font-size:.88rem;margin:0">Hola <strong>${escHtml(cita.nombre)}</strong>, te esperamos en tu cita.</p>
      </div>

      <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:4px">
        ${detalle('🔖', 'N° Cita', String(cita.id))}
        ${detalle('📅', 'Fecha', cita.fecha)}
        ${detalle('🕐', 'Hora', cita.hora + ' (hora Ecuador)')}
        ${detalle(esZoom ? '💻' : '📱', 'Medio', esZoom ? 'Videollamada Zoom' : 'WhatsApp')}
      </div>

      ${contactoBloque}

      <p style="font-size:.78rem;color:#94a3b8;text-align:center;margin-top:20px;line-height:1.6">
        Si necesitas reprogramar o tienes dudas, responde este correo o escríbenos por WhatsApp.
      </p>
    </div>
    <div style="background:#f8f7f4;padding:18px 40px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:.7rem;color:#94a3b8">Puente Legal Internacional EC · Ecuador · Nacional e Internacional</div>
    </div>
  </div>
</body>
</html>`;

  await createTransport().sendMail({
    from: `"Puente Legal" <${from}>`,
    to: cita.email,
    subject: `✅ Cita confirmada — ${cita.fecha} ${cita.hora} | Puente Legal`,
    html
  });

  console.log(`[email] Confirmación enviada a ${cita.email} (cita #${cita.id})`);
}

function detalle(ico, lbl, val) {
  return `<div style="display:flex;align-items:center;gap:12px;padding:13px 18px;border-bottom:1px solid #f1f5f9">
    <span style="font-size:1rem;width:24px;text-align:center">${ico}</span>
    <span style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;font-weight:700;width:52px">${lbl}</span>
    <span style="font-size:.88rem;font-weight:700;color:#0f1e38">${escHtml(val)}</span>
  </div>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendOTP(email, code) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log(`[email] OTP para ${email}: ${code}`);
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:#f8f7f4;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:#0f1e38;padding:28px 36px;text-align:center">
      <div style="font-size:1.2rem;font-weight:800;color:#C9A227;letter-spacing:2px">PUENTE LEGAL</div>
      <div style="font-size:.68rem;color:rgba(255,255,255,.3);margin-top:3px;letter-spacing:1px">INTERNACIONAL EC</div>
    </div>
    <div style="padding:36px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:2.2rem;margin-bottom:10px">🔐</div>
        <h1 style="font-size:1.1rem;color:#0f1e38;margin:0 0 6px;font-weight:700">Código de verificación</h1>
        <p style="color:#64748b;font-size:.84rem;margin:0">Ingresa este código en el formulario de cita</p>
      </div>
      <div style="background:#f8f7f4;border-radius:12px;padding:28px;text-align:center;margin:0 0 24px">
        <div style="font-size:2.6rem;font-weight:800;color:#0f1e38;letter-spacing:12px;font-family:'Courier New',monospace">${code}</div>
        <div style="font-size:.72rem;color:#94a3b8;margin-top:10px">Válido por 10 minutos</div>
      </div>
      <p style="font-size:.75rem;color:#94a3b8;text-align:center;line-height:1.6">Si no solicitaste este código, ignora este mensaje.</p>
    </div>
    <div style="background:#f8f7f4;padding:16px 36px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:.68rem;color:#94a3b8">Puente Legal Internacional EC</div>
    </div>
  </div>
</body>
</html>`;
  await createTransport().sendMail({
    from: `"Puente Legal" <${from}>`,
    to: email,
    subject: `🔐 Tu código: ${code} — Puente Legal`,
    html
  });
  console.log(`[email] OTP enviado a ${email}`);
}

module.exports = { sendCitaConfirmada, sendOTP };
