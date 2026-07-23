// Envío por la API HTTPS de Resend (no SMTP): Railway bloquea los puertos
// SMTP salientes (25/465/587) en planes Free/Trial/Hobby, así que el envío
// por SMTP se queda colgado ahí. La API por HTTPS usa el puerto 443, que
// nunca está bloqueado.
const RESEND_FROM = process.env.EMAIL_FROM || process.env.SMTP_FROM;

async function sendViaResend({ to, subject, html, attachments }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `Puente Legal <${RESEND_FROM}>`,
      to: [to],
      subject,
      html,
      ...(attachments && attachments.length ? { attachments } : {})
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Resend respondió ${res.status}`);
  return body; // { id: '...' } — el id se usa para correlacionar rebotes (webhook)
}

async function sendCitaConfirmada(cita) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY no configurada — skipping cita id:', cita.id);
    return;
  }

  const esZoom = cita.contacto_tipo === 'zoom';

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

  await sendViaResend({
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
  if (!process.env.RESEND_API_KEY) {
    // No registrar el código en logs de producción
    if (process.env.NODE_ENV !== 'production') console.log(`[email] OTP para ${email}: ${code}`);
    return;
  }
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
  const result = await sendViaResend({
    to: email,
    subject: `🔐 Tu código: ${code} — Puente Legal`,
    html
  });
  console.log(`[email] OTP enviado a ${email}`);
  return result && result.id;
}

async function sendFacturaEmitida(factura) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY no configurada — skipping factura id:', factura.id);
    return;
  }
  if (!factura.cliente_email) {
    console.log('[email] Factura sin email de cliente — skipping factura id:', factura.id);
    return;
  }

  let sriData = {};
  try { sriData = JSON.parse(factura.sri_data || '{}'); } catch { /* noop */ }

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
        <div style="font-size:2.8rem;margin-bottom:12px">🧾</div>
        <h1 style="font-size:1.25rem;color:#0f1e38;margin:0 0 8px;font-weight:700">Tu factura electrónica</h1>
        <p style="color:#64748b;font-size:.88rem;margin:0">Hola <strong>${escHtml(factura.cliente_nombre)}</strong>, adjuntamos tu comprobante autorizado por el SRI.</p>
      </div>

      <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:4px">
        ${detalle('🔖', 'N° Factura', factura.numero_factura)}
        ${detalle('📄', 'Concepto', factura.concepto || '—')}
        ${detalle('💵', 'Subtotal', '$' + parseFloat(factura.subtotal).toFixed(2))}
        ${detalle('➕', 'IVA (' + factura.iva_rate + '%)', '$' + parseFloat(factura.iva).toFixed(2))}
        ${detalle('💰', 'Total', '$' + parseFloat(factura.monto).toFixed(2))}
      </div>

      <div style="background:#f8f7f4;border-radius:10px;padding:16px 18px;margin-top:20px">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;font-weight:700;margin-bottom:6px">Clave de acceso</div>
        <div style="font-size:.72rem;color:#0f1e38;word-break:break-all;font-family:'Courier New',monospace">${escHtml(factura.clave_acceso)}</div>
      </div>

      <p style="font-size:.78rem;color:#94a3b8;text-align:center;margin-top:20px;line-height:1.6">
        El archivo XML adjunto es tu comprobante fiscalmente válido ante el SRI. Consérvalo para tu contabilidad.
      </p>
    </div>
    <div style="background:#f8f7f4;padding:18px 40px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:.7rem;color:#94a3b8">Puente Legal Internacional EC · Ecuador · Nacional e Internacional</div>
    </div>
  </div>
</body>
</html>`;

  const attachments = [];
  if (sriData.xmlAutorizado) {
    attachments.push({
      filename: `${factura.numero_factura}.xml`,
      content: Buffer.from(sriData.xmlAutorizado, 'utf8').toString('base64'),
      content_type: 'application/xml'
    });
  }

  await sendViaResend({
    to: factura.cliente_email,
    subject: `🧾 Factura electrónica N° ${factura.numero_factura} — Puente Legal`,
    html,
    attachments
  });

  console.log(`[email] Factura enviada a ${factura.cliente_email} (factura #${factura.id})`);
}

async function sendCorreoAdjunto(cita, titulo, mensaje, file) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY no configurada — skipping correo cita id:', cita.id);
    return;
  }
  if (!cita.email) {
    console.log('[email] Cita sin email — skipping correo cita id:', cita.id);
    return;
  }

  const mensajeHtml = escHtml(mensaje).replace(/\n/g, '<br>');

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
      <h1 style="font-size:1.2rem;color:#0f1e38;margin:0 0 18px;font-weight:700">${escHtml(titulo)}</h1>
      <p style="color:#0f1e38;font-size:.88rem;line-height:1.7;margin:0">${mensajeHtml}</p>
    </div>
    <div style="background:#f8f7f4;padding:18px 40px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:.7rem;color:#94a3b8">Puente Legal Internacional EC · Ecuador · Nacional e Internacional</div>
    </div>
  </div>
</body>
</html>`;

  const attachments = [];
  if (file) attachments.push({ filename: file.originalname, content: file.buffer.toString('base64'), content_type: file.mimetype });

  await sendViaResend({
    to: cita.email,
    subject: `${titulo} — Puente Legal`,
    html,
    attachments
  });

  console.log(`[email] Correo con adjunto enviado a ${cita.email} (cita #${cita.id})`);
}

// A diferencia de sendCorreoAdjunto (va al cliente), este va a la notaría —
// el email de destino no está guardado en la cita, lo escribe el admin cada
// vez. Los datos del cliente (nombre/cédula-RUC) se arman automáticamente
// en el cuerpo, el admin solo agrega el mensaje libre.
async function sendCorreoNotaria(cita, notariaEmail, titulo, mensaje, file) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY no configurada — skipping correo notaría cita id:', cita.id);
    return;
  }

  const mensajeHtml = escHtml(mensaje).replace(/\n/g, '<br>');

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
      <h1 style="font-size:1.2rem;color:#0f1e38;margin:0 0 18px;font-weight:700">${escHtml(titulo)}</h1>
      <div style="background:#f8f7f4;border-radius:10px;padding:16px 18px;margin-bottom:20px">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;font-weight:700;margin-bottom:8px">Datos del cliente</div>
        <div style="font-size:.85rem;color:#0f1e38;line-height:1.6">
          <strong>${escHtml(cita.nombre)}</strong><br>
          Cédula/RUC: ${escHtml(cita.cliente_doc || '—')}
        </div>
      </div>
      <p style="color:#0f1e38;font-size:.88rem;line-height:1.7;margin:0">${mensajeHtml}</p>
    </div>
    <div style="background:#f8f7f4;padding:18px 40px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:.7rem;color:#94a3b8">Puente Legal Internacional EC · Ecuador · Nacional e Internacional</div>
    </div>
  </div>
</body>
</html>`;

  const attachments = [];
  if (file) attachments.push({ filename: file.originalname, content: file.buffer.toString('base64'), content_type: file.mimetype });

  await sendViaResend({
    to: notariaEmail,
    subject: `${titulo} — Puente Legal`,
    html,
    attachments
  });

  console.log(`[email] Correo a notaría enviado a ${notariaEmail} (cita #${cita.id})`);
}

// Avisa al correo de notificaciones configurado en el admin (Cuenta →
// Correo de notificaciones) cada vez que un cliente sube un comprobante de
// pago, para no depender de revisar el panel manualmente.
async function sendComprobanteNotificacion(cita, notifEmail) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY no configurada — skipping notificación comprobante cita id:', cita.id);
    return;
  }

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
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:2.2rem;margin-bottom:10px">📎</div>
        <h1 style="font-size:1.1rem;color:#0f1e38;margin:0 0 6px;font-weight:700">Nuevo comprobante de pago</h1>
        <p style="color:#64748b;font-size:.84rem;margin:0">Un cliente subió un comprobante — revísalo en el panel admin</p>
      </div>
      ${detalle('🔖', 'N° Cita', String(cita.id))}
      ${detalle('👤', 'Cliente', cita.nombre || '—')}
    </div>
    <div style="background:#f8f7f4;padding:16px 36px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:.68rem;color:#94a3b8">Puente Legal Internacional EC</div>
    </div>
  </div>
</body>
</html>`;

  await sendViaResend({
    to: notifEmail,
    subject: `📎 Nuevo comprobante — Cita #${cita.id} — Puente Legal`,
    html
  });

  console.log(`[email] Notificación de comprobante enviada a ${notifEmail} (cita #${cita.id})`);
}

// Avisa al correo de notificaciones cada vez que se agenda una cita por
// Zoom — el equivalente por correo del wa.me que el frontend abre para
// avisos por WhatsApp, que en Zoom no aplica porque no hay un WhatsApp
// propio del cliente para eso.
async function sendCitaNuevaNotificacion(cita, notifEmail) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY no configurada — skipping notificación nueva cita id:', cita.id);
    return;
  }

  const esZoom = cita.contacto_tipo !== 'whatsapp';
  const medioLabel = esZoom ? 'Videollamada Zoom' : 'WhatsApp';
  const medioIco   = esZoom ? '💻' : '📱';
  // En WhatsApp se muestra además el número que dejó el cliente.
  const contactoDetalle = esZoom
    ? ''
    : detalle('📱', 'WhatsApp', cita.contacto_valor || '—');

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
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:2.2rem;margin-bottom:10px">📅</div>
        <h1 style="font-size:1.1rem;color:#0f1e38;margin:0 0 6px;font-weight:700">Nueva cita agendada</h1>
        <p style="color:#64748b;font-size:.84rem;margin:0">${medioLabel} — revísala en el panel admin</p>
      </div>
      ${detalle('🔖', 'N° Cita', String(cita.id))}
      ${detalle('👤', 'Cliente', cita.nombre || '—')}
      ${detalle('📧', 'Correo', cita.email || '—')}
      ${detalle('📅', 'Fecha', cita.fecha || '—')}
      ${detalle('🕐', 'Hora', (cita.hora || '—') + ' (hora Ecuador)')}
      ${detalle(medioIco, 'Medio', medioLabel)}
      ${contactoDetalle}
    </div>
    <div style="background:#f8f7f4;padding:16px 36px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:.68rem;color:#94a3b8">Puente Legal Internacional EC</div>
    </div>
  </div>
</body>
</html>`;

  await sendViaResend({
    to: notifEmail,
    subject: `📅 Nueva cita ${esZoom ? 'Zoom' : 'WhatsApp'} — #${cita.id} ${cita.fecha} ${cita.hora} — Puente Legal`,
    html
  });

  console.log(`[email] Notificación de nueva cita enviada a ${notifEmail} (cita #${cita.id})`);
}

module.exports = { sendCitaConfirmada, sendOTP, sendFacturaEmitida, sendCorreoAdjunto, sendCorreoNotaria, sendComprobanteNotificacion, sendCitaNuevaNotificacion };
