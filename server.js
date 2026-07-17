const express = require('express');
const path = require('path');
const fs = require('fs');
const { initDB } = require('./database');
const securityHeaders = require('./middleware/securityHeaders');

const app = express();
const PORT = process.env.PORT || 3000;
// DB_PATH debe apuntar dentro de un Volumen persistente en Railway (ej. /data/data.db)
// — si no, data.db, comprobantes/ y firma.p12 se pierden en cada deploy.

// Detrás del proxy de Railway: necesario para obtener la IP real (rate limiting)
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(express.json({ limit: '256kb' }));
// index:false — public/index.html se sirve a mano (abajo) para poder
// inyectarle el nonce de CSP; el resto de los archivos estáticos sigue igual.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/img', express.static(path.join(__dirname, 'img')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));

// Sirve un HTML con su único <script> marcado con el nonce de esta request
// (ver middleware/securityHeaders.js) — necesario porque la CSP ya no
// permite 'unsafe-inline' en script-src.
function sendWithNonce(res, filePath) {
  const html = fs.readFileSync(filePath, 'utf8').replace('<script>', `<script nonce="${res.locals.cspNonce}">`);
  res.type('html').send(html);
}

app.get('/admin', (req, res) => sendWithNonce(res, path.join(__dirname, 'admin', 'index.html')));
app.get('*', (req, res) => sendWithNonce(res, path.join(__dirname, 'public', 'index.html')));

initDB();
app.listen(PORT, () => console.log(`Puente Legal corriendo en puerto ${PORT}`));
