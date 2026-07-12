const express = require('express');
const path = require('path');
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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/img', express.static(path.join(__dirname, 'img')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB();
app.listen(PORT, () => console.log(`Puente Legal corriendo en puerto ${PORT}`));
