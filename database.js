const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
let db;

function getDB() {
  if (!db) db = new Database(DB_PATH);
  return db;
}

function initDB() {
  const db = getDB();

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS testimonios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      initials TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      flag TEXT NOT NULL DEFAULT '🌍',
      stars INTEGER NOT NULL DEFAULT 5,
      text TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS servicios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contenido (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacto (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promo_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      badge TEXT NOT NULL DEFAULT '',
      bullets TEXT NOT NULL DEFAULT '[]',
      image TEXT NOT NULL DEFAULT '',
      cta_text TEXT NOT NULL DEFAULT 'Contáctanos',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS citas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      contacto_tipo TEXT NOT NULL DEFAULT 'zoom',
      contacto_valor TEXT NOT NULL DEFAULT '',
      zoom_link TEXT NOT NULL DEFAULT '',
      estado TEXT NOT NULL DEFAULT 'pendiente',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(fecha, hora)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS otp_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS facturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cita_id INTEGER,
      cliente_nombre TEXT NOT NULL DEFAULT '',
      cliente_email  TEXT NOT NULL DEFAULT '',
      cliente_doc    TEXT NOT NULL DEFAULT '',
      monto          REAL NOT NULL DEFAULT 0,
      subtotal       REAL NOT NULL DEFAULT 0,
      iva            REAL NOT NULL DEFAULT 0,
      iva_rate       REAL NOT NULL DEFAULT 15,
      concepto       TEXT NOT NULL DEFAULT '',
      forma_pago     TEXT NOT NULL DEFAULT '20',
      estab          TEXT NOT NULL DEFAULT '',
      pto_emi        TEXT NOT NULL DEFAULT '',
      secuencial     INTEGER NOT NULL DEFAULT 0,
      fecha_emision  TEXT NOT NULL DEFAULT '',
      numero_factura TEXT NOT NULL DEFAULT '',
      clave_acceso   TEXT NOT NULL DEFAULT '',
      sri_estado     TEXT NOT NULL DEFAULT 'pendiente',
      sri_data       TEXT NOT NULL DEFAULT '{}',
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facturas_estab_ptoemi ON facturas(estab, pto_emi)`);

  // Contador de secuencial independiente de la tabla facturas: si se borra una
  // factura (ej. limpieza de pruebas), el número de la próxima factura NO debe
  // repetirse — nunca retrocede, solo avanza.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sri_secuenciales (
      estab   TEXT NOT NULL,
      pto_emi TEXT NOT NULL,
      ultimo  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (estab, pto_emi)
    );
  `);
  // Si ya había facturas emitidas antes de este cambio, arranca el contador
  // desde el secuencial más alto ya usado (nunca desde 0), para no repetir
  // números que el SRI ya autorizó.
  const maxPorPunto = db.prepare('SELECT estab, pto_emi, MAX(secuencial) as m FROM facturas GROUP BY estab, pto_emi').all();
  maxPorPunto.forEach(({ estab, pto_emi, m }) => {
    db.prepare(`INSERT INTO sri_secuenciales (estab, pto_emi, ultimo) VALUES (?, ?, ?)
      ON CONFLICT(estab, pto_emi) DO UPDATE SET ultimo = MAX(ultimo, excluded.ultimo)`).run(estab, pto_emi, m || 0);
  });

  // Migración: agregar columnas nuevas si no existen (para DBs existentes en producción)
  const citasCols = db.prepare('PRAGMA table_info(citas)').all().map(c => c.name);
  if (!citasCols.includes('contacto_tipo'))
    db.exec("ALTER TABLE citas ADD COLUMN contacto_tipo TEXT NOT NULL DEFAULT 'zoom'");
  if (!citasCols.includes('contacto_valor'))
    db.exec("ALTER TABLE citas ADD COLUMN contacto_valor TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('zoom_link'))
    db.exec("ALTER TABLE citas ADD COLUMN zoom_link TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('resumen_titulo'))
    db.exec("ALTER TABLE citas ADD COLUMN resumen_titulo TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('resumen_texto'))
    db.exec("ALTER TABLE citas ADD COLUMN resumen_texto TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('comprobante_path'))
    db.exec("ALTER TABLE citas ADD COLUMN comprobante_path TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('comprobante_estado'))
    db.exec("ALTER TABLE citas ADD COLUMN comprobante_estado TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('facturado'))
    db.exec("ALTER TABLE citas ADD COLUMN facturado INTEGER NOT NULL DEFAULT 0");
  if (!citasCols.includes('monto_pagado'))
    db.exec("ALTER TABLE citas ADD COLUMN monto_pagado REAL NOT NULL DEFAULT 0");
  if (!citasCols.includes('cliente_doc'))
    db.exec("ALTER TABLE citas ADD COLUMN cliente_doc TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('factura_estado'))
    db.exec("ALTER TABLE citas ADD COLUMN factura_estado TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('factura_id'))
    db.exec('ALTER TABLE citas ADD COLUMN factura_id INTEGER');
  if (!citasCols.includes('correo_enviado_at'))
    db.exec("ALTER TABLE citas ADD COLUMN correo_enviado_at TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('cliente_telefono'))
    db.exec("ALTER TABLE citas ADD COLUMN cliente_telefono TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('factura_descripcion'))
    db.exec("ALTER TABLE citas ADD COLUMN factura_descripcion TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('correo_notaria_enviado_at'))
    db.exec("ALTER TABLE citas ADD COLUMN correo_notaria_enviado_at TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('correo_adjunto_nombre'))
    db.exec("ALTER TABLE citas ADD COLUMN correo_adjunto_nombre TEXT NOT NULL DEFAULT ''");
  if (!citasCols.includes('correo_notaria_adjunto_nombre'))
    db.exec("ALTER TABLE citas ADD COLUMN correo_notaria_adjunto_nombre TEXT NOT NULL DEFAULT ''");
  // Número de referencia mostrado en el admin: la primera cita de un cliente
  // (mismo nombre+correo) lleva su propio id; las siguientes llevan
  // "<id-de-la-primera>-1", "-2", etc. Ver routes/api.js (POST /citas).
  if (!citasCols.includes('ref_display'))
    db.exec("ALTER TABLE citas ADD COLUMN ref_display TEXT NOT NULL DEFAULT ''");

  // Migración: quitar el prefijo "SL-" de los números de cita viejos. La
  // numeración nueva ya no lo usa (es 0000001 / 0000001-1); esto normaliza los
  // registros creados antes del cambio. Idempotente (solo afecta a los que lo tienen).
  db.exec("UPDATE citas SET ref_display = SUBSTR(ref_display, 4) WHERE ref_display LIKE 'SL-%'");

  // Migración: teléfono del cliente en la factura (dato informativo, no se envía al SRI)
  const facturasCols = db.prepare('PRAGMA table_info(facturas)').all().map(c => c.name);
  if (!facturasCols.includes('cliente_telefono'))
    db.exec("ALTER TABLE facturas ADD COLUMN cliente_telefono TEXT NOT NULL DEFAULT ''");

  // Migración: agregar datos bancarios y SRI a contacto si no existen
  const existingContacto = db.prepare('SELECT key FROM contacto').all().map(r => r.key);
  const insContacto = db.prepare('INSERT OR IGNORE INTO contacto (key,value) VALUES (?,?)');
  const contactoDefaults = {
    whatsapp:              '593000000000',
    telefono:              '+593 00 000 0000',
    email:                 'info@puentelegal.ec',
    cobertura:             'Ecuador · Nacional e Internacional',
    banco_nombre:          'Banco Pichincha',
    banco_titular:         'Puente Legal Internacional EC',
    banco_tipo:            'Corriente',
    banco_cuenta:          '0000000000',
    banco_nota:            'Envía el comprobante por WhatsApp al +593 99 652 6419 indicando tu número de cita. Procesamos la confirmación en menos de 2 horas hábiles.',
    email_notificaciones:  '',
    sri_ambiente:          '1',
    sri_ruc:               '',
    sri_razon_social:      '',
    sri_nombre_comercial:  '',
    sri_direccion:         '',
    sri_estab:             '001',
    sri_pto_emi:           '001',
    sri_iva_rate:          '15',
    p12_password:          '',
  };
  Object.entries(contactoDefaults).forEach(([k, v]) => {
    if (!existingContacto.includes(k)) insContacto.run(k, v);
  });

  // Migración: flag para forzar cambio de contraseña en el primer acceso
  const adminCols = db.prepare('PRAGMA table_info(admin_users)').all().map(c => c.name);
  if (!adminCols.includes('must_change_password'))
    db.exec('ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');

  // Migración: contador de intentos para limitar fuerza bruta de OTP
  const otpCols = db.prepare('PRAGMA table_info(otp_verifications)').all().map(c => c.name);
  if (!otpCols.includes('attempts'))
    db.exec('ALTER TABLE otp_verifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  // Migración: id del correo en Resend + marca de rebote (bounce), para poder
  // avisarle al cliente si el correo que escribió no existe/rebota mientras
  // está esperando el código de verificación.
  if (!otpCols.includes('resend_email_id'))
    db.exec("ALTER TABLE otp_verifications ADD COLUMN resend_email_id TEXT NOT NULL DEFAULT ''");
  if (!otpCols.includes('bounced_at'))
    db.exec('ALTER TABLE otp_verifications ADD COLUMN bounced_at TEXT');
  if (!otpCols.includes('delivered_at'))
    db.exec('ALTER TABLE otp_verifications ADD COLUMN delivered_at TEXT');

  // Admin por defecto
  const adminExists = db.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin');
  if (!adminExists) {
    // La contraseña inicial se toma de ADMIN_INITIAL_PASSWORD si está definida.
    // Si no, se usa una temporal y se OBLIGA a cambiarla en el primer login.
    const initialPass = process.env.ADMIN_INITIAL_PASSWORD || 'puentelegal2026';
    const mustChange  = process.env.ADMIN_INITIAL_PASSWORD ? 0 : 1;
    const hash = bcrypt.hashSync(initialPass, 10);
    db.prepare('INSERT INTO admin_users (username, password_hash, must_change_password) VALUES (?, ?, ?)')
      .run('admin', hash, mustChange);
    console.log('✓ Usuario admin creado' + (mustChange ? ' (deberá cambiar la contraseña en el primer acceso)' : ''));
  }

  // Testimonios iniciales
  const tc = db.prepare('SELECT COUNT(*) as c FROM testimonios').get();
  if (tc.c === 0) {
    const ins = db.prepare(`INSERT INTO testimonios (name,initials,location,flag,stars,text,service,date,sort_order)
      VALUES (@name,@initials,@location,@flag,@stars,@text,@service,@date,@sort_order)`);
    [
      { name:'María González',  initials:'MG', location:'Madrid, España',         flag:'🇪🇸', stars:5, text:'Necesitaba un poder notarial urgente desde España y pensé que sería imposible. Puente Legal lo resolvió en 3 días, completamente en línea. Profesionales, rápidos y muy claros en cada paso.',                                                              service:'Poderes Notariales',            date:'Dic 2025', sort_order:1 },
      { name:'Carlos Toro',     initials:'CT', location:'Miami, Estados Unidos',   flag:'🇺🇸', stars:5, text:'Tuve un problema con una herencia en Ecuador estando en Estados Unidos. El equipo me guió en todo el proceso, explicaron cada detalle y resolvieron en tiempo récord. Totalmente recomendado.',                                                           service:'Procesos Judiciales',           date:'Nov 2025', sort_order:2 },
      { name:'Andrea Russo',    initials:'AR', location:'Roma, Italia',            flag:'🇮🇹', stars:5, text:'Constituí mi empresa en Ecuador desde Italia sin ningún problema. El proceso fue claro, el precio justo y la comunicación excelente. Ya los he recomendado a varios compatriotas.',                                                                       service:'Asuntos Societarios',           date:'Oct 2025', sort_order:3 },
      { name:'Luis Paredes',    initials:'LP', location:'Toronto, Canadá',         flag:'🇨🇦', stars:5, text:'Excelente servicio. Necesitaba representación ante el SRI y lo resolvieron de manera impecable. Comunicación fluida y resultados que superaron mis expectativas. 100% recomendados.',                                                                   service:'Representación ante Entidades', date:'Sep 2025', sort_order:4 },
      { name:'Patricia Méndez', initials:'PM', location:'Barcelona, España',       flag:'🇪🇸', stars:5, text:'Herencia complicada resuelta con total profesionalismo. Siempre disponibles para responder dudas, precios honestos y sin sorpresas. Gracias al equipo de Puente Legal.',                                                                               service:'Procesos Judiciales',           date:'Ago 2025', sort_order:5 },
      { name:'Roberto Vásquez', initials:'RV', location:'Buenos Aires, Argentina', flag:'🇦🇷', stars:5, text:'Mi contrato de compraventa en Ecuador fue revisado y tramitado sin inconvenientes. Muy profesionales y atentos. El servicio 100% remoto funcionó perfectamente desde Argentina.',                                                                       service:'Contratos y Asesoría',          date:'Jul 2025', sort_order:6 }
    ].forEach(t => ins.run(t));
  }

  // Servicios iniciales
  const sc = db.prepare('SELECT COUNT(*) as c FROM servicios').get();
  if (sc.c === 0) {
    const ins = db.prepare(`INSERT INTO servicios (num,title,description,tags,sort_order)
      VALUES (@num,@title,@description,@tags,@sort_order)`);
    [
      { num:'01', title:'Poderes y Trámites Notariales',     description:'Poderes especiales y generales, escrituras ante notaría ecuatoriana. Válidos aunque te encuentres en el exterior.',                                          tags:JSON.stringify(['Poder especial','Escritura']),  sort_order:1 },
      { num:'02', title:'Procesos Judiciales',               description:'Representación y defensa en juicios civiles, penales, laborales y administrativos en todas las instancias.',                                                   tags:JSON.stringify(['Civil','Penal','Laboral']),                 sort_order:2 },
      { num:'03', title:'Asuntos Societarios',               description:'Constitución de empresas, reformas estatutarias, juntas de accionistas y cumplimiento corporativo.',                                                           tags:JSON.stringify(['Constitución','Estatutos','Compliance']),   sort_order:3 },
      { num:'04', title:'Contratos y Asesoría Legal',        description:'Redacción y revisión de contratos civiles y mercantiles. Asesoramiento preventivo para proteger tus intereses.',                                             tags:JSON.stringify(['Contratos','Revisión','Asesoría']),         sort_order:4 },
      { num:'05', title:'Representación ante Entidades',     description:'Actuamos en tu nombre ante SRI, IESS, Registros de la Propiedad, Ministerios y entidades públicas.',                                                          tags:JSON.stringify(['SRI','IESS','Ministerios']),                sort_order:5 },
      { num:'06', title:'Consulta Legal Express',            description:'Primera consulta gratuita por WhatsApp con un abogado especializado. Respuesta garantizada en 24 horas.',                                                     tags:JSON.stringify(['Gratis','WhatsApp','24h']),                 sort_order:6 }
    ].forEach(s => ins.run(s));
  }

  // Contenido general inicial
  const cc = db.prepare('SELECT COUNT(*) as c FROM contenido').get();
  if (cc.c === 0) {
    const ins = db.prepare('INSERT INTO contenido (key,value) VALUES (?,?)');
    [
      ['hero_pill',       'Ecuador · Internacional'],
      ['hero_title',      'Tu representación legal en Ecuador,\nestés donde estés.'],
      ['hero_sub',        'Gestionamos tus trámites jurídicos de forma 100% remota. Sin visitas presenciales, honorarios transparentes y resultados concretos desde cualquier país.'],
      ['stat_casos',      '500'],
      ['stat_paises',     '40'],
      ['stat_anos',       '10'],
      ['stat_respuesta',  '24'],
      ['trust_rating',    '4.9'],
      ['trust_reviews',   '200'],
      ['banner_texto',    'Sin visita presencial, desde cualquier país'],
      ['faq_1_q', '¿Necesito viajar a Ecuador para hacer mis trámites?'],
      ['faq_1_a', 'No. Todos nuestros servicios son 100% remotos. Gestionamos todo desde el poder notarial hasta los procesos judiciales sin que tengas que desplazarte a Ecuador. La firma de documentos se puede hacer con apostilla desde tu país de residencia.'],
      ['faq_2_q', '¿Cuánto tiempo toma obtener un poder notarial?'],
      ['faq_2_a', 'En promedio, entre 5 y 15 días hábiles contando la apostilla en tu país de residencia. Para casos urgentes tenemos un servicio express con tiempos reducidos.'],
      ['faq_3_q', '¿Cuáles son los métodos de pago aceptados?'],
      ['faq_3_a', 'Aceptamos transferencia bancaria internacional, PayPal, Western Union y tarjeta de crédito. Siempre enviamos un presupuesto detallado antes de iniciar cualquier trámite. Sin pagos ocultos.'],
      ['faq_4_q', '¿La consulta inicial es realmente gratuita?'],
      ['faq_4_a', 'Sí, completamente. La primera consulta por WhatsApp es gratuita y sin compromiso. Un abogado especializado evaluará tu caso y te orientará sobre opciones y costos antes de que tomes cualquier decisión.'],
      ['faq_5_q', '¿Pueden representarme ante el SRI, IESS u otras entidades?'],
      ['faq_5_a', 'Sí. Actuamos como tu representante legal ante cualquier entidad pública: SRI, IESS, Registro de la Propiedad, Registro Mercantil, Superintendencia de Compañías, Ministerios y más.'],
      ['faq_6_q', '¿Cómo garantizan la confidencialidad?'],
      ['faq_6_a', 'Todos nuestros abogados están sujetos al secreto profesional establecido por el Código de Ética de la Federación de Abogados del Ecuador. Nunca compartimos información de nuestros clientes con terceros.'],
    ].forEach(([k,v]) => ins.run(k,v));
  }

  // (Los valores por defecto de `contacto` se siembran arriba de forma idempotente
  //  con INSERT OR IGNORE, cubriendo tanto bases nuevas como existentes.)

  // Promo cards iniciales
  const pc = db.prepare('SELECT COUNT(*) as c FROM promo_cards').get();
  if (pc.c === 0) {
    const ins = db.prepare(`INSERT INTO promo_cards (title,subtitle,description,badge,bullets,image,cta_text,sort_order)
      VALUES (@title,@subtitle,@description,@badge,@bullets,@image,@cta_text,@sort_order)`);
    [
      {
        title: 'Firma Electrónica al Instante',
        subtitle: 'Rápido · Seguro · 100% Online',
        description: 'Obtén tu firma electrónica de forma rápida, segura y completamente en línea. Sin trasladarte desde tu casa o negocio.',
        badge: 'Disponible ahora',
        bullets: JSON.stringify(['Obtén tu firma en minutos','Respaldo legal válido ante el SRI','Confidencialidad garantizada','Soporte y asesoría personalizada']),
        image: '/img/servicioadicional2.jpg',
        cta_text: 'Solicitar firma electrónica',
        sort_order: 1
      },
      {
        title: 'Soluciones Tributarias & Contables',
        subtitle: 'SRI · Impuestos · Contabilidad',
        description: 'Nos enfocamos en darte respuestas rápidas, claras y efectivas. Atención personalizada para personas y empresas.',
        badge: 'Expertos SRI',
        bullets: JSON.stringify(['Actualización de RUC','Declaraciones de impuestos y anexos','Devolución de IVA y Renta','Obtención y renovación de claves electrónicas']),
        image: '/img/servicioadicional3.jpg',
        cta_text: 'Consultar servicio',
        sort_order: 2
      },
      {
        title: 'Facturación Electrónica Obligatoria',
        subtitle: 'Obligatorio · Capacitación · Asesoría',
        description: 'Te ayudamos a cumplir con la normativa de facturación electrónica del SRI de forma fácil, rápida y sin complicaciones.',
        badge: 'Normativa SRI',
        bullets: JSON.stringify(['Cumple con la normativa y evita sanciones','Instalación del sistema de facturación','Capacitación completa sobre su uso','Acompañamiento personalizado continuo']),
        image: '/img/servicioadicional1.jpg',
        cta_text: 'Consultar servicio',
        sort_order: 3
      }
    ].forEach(p => ins.run(p));
  }

  console.log('✓ Base de datos lista');
}

module.exports = { getDB, initDB };
