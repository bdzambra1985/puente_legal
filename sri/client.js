'use strict';

const https  = require('https');
const crypto = require('crypto');

const URLS = {
    recepcion: {
        '1': 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
        '2': 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    },
    autorizacion: {
        '1': 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
        '2': 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    },
};

// Extrae los bloques <mensaje> del XML del SRI.
// Usa seguimiento de profundidad porque <mensaje> es también nombre de campo interno.
function parseMensajes(xml) {
    const mensajesMatch = xml.match(/<mensajes>([\s\S]*?)<\/mensajes>/);
    if (!mensajesMatch) return [];
    const src = mensajesMatch[1];
    const result = [];
    let depth = 0, start = -1, i = 0;
    while (i < src.length) {
        if (src.startsWith('<mensaje>', i)) {
            if (depth === 0) start = i + '<mensaje>'.length;
            depth++;
            i += 9; // '<mensaje>'.length
        } else if (src.startsWith('</mensaje>', i)) {
            depth--;
            if (depth === 0 && start >= 0) {
                const blk = src.substring(start, i);
                const msg = {
                    identificador:        tagValue(blk, 'identificador'),
                    tipo:                 tagValue(blk, 'tipo'),
                    mensaje:              tagValue(blk, 'mensaje'),
                    informacionAdicional: tagValue(blk, 'informacionAdicional'),
                };
                if (msg.identificador || msg.mensaje || msg.tipo) result.push(msg);
                start = -1;
            }
            i += 10; // '</mensaje>'.length
        } else {
            i++;
        }
    }
    return result;
}

function soapPost(url, bodyXml) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;

    return new Promise((resolve, reject) => {
        const u    = new URL(url);
        const data = Buffer.from(envelope, 'utf8');
        const opts = {
            hostname:      u.hostname,
            path:          u.pathname + u.search,
            port:          443,
            method:        'POST',
            secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
            headers: {
                'Content-Type':   'text/xml;charset=UTF-8',
                'Content-Length': data.length,
            },
        };
        const req = https.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function tagValue(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].trim() : '';
}

function cdataOrText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? m[1].trim() : '';
}

/**
 * Envía el XML firmado al SRI (recepción).
 * @param {string} xmlSigned  XML firmado (string UTF-8)
 * @param {string|number} ambiente  '1'=pruebas '2'=producción
 * @returns {{ estado: string, mensajes: Array }}
 */
async function enviarComprobante(xmlSigned, ambiente) {
    const xmlBase64 = Buffer.from(xmlSigned, 'utf8').toString('base64');
    const body = `<rec:validarComprobante xmlns:rec="http://ec.gob.sri.ws.recepcion">
  <xml>${xmlBase64}</xml>
</rec:validarComprobante>`;

    const url      = URLS.recepcion[String(ambiente)] || URLS.recepcion['1'];
    const response = await soapPost(url, body);
    console.log('SRI recepcion RAW:', response.slice(0, 2000));

    const estado   = tagValue(response, 'estado');
    const mensajes = parseMensajes(response);
    return { estado, mensajes };
}

/**
 * Consulta la autorización del comprobante.
 * @param {string} claveAcceso  Clave de acceso de 49 dígitos
 * @param {string|number} ambiente
 * @returns {{ autorizaciones: Array }}
 */
async function autorizarComprobante(claveAcceso, ambiente) {
    const body = `<aut:autorizacionComprobante xmlns:aut="http://ec.gob.sri.ws.autorizacion">
  <claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>
</aut:autorizacionComprobante>`;

    const url      = URLS.autorizacion[String(ambiente)] || URLS.autorizacion['1'];
    const response = await soapPost(url, body);
    console.log('SRI autorizacion RAW:', response.slice(0, 2000));

    const autorizaciones = [];
    const re = /<autorizacion>([\s\S]*?)<\/autorizacion>/g;
    let m;
    while ((m = re.exec(response)) !== null) {
        const blk = m[1];
        autorizaciones.push({
            estado:             tagValue(blk, 'estado'),
            numeroAutorizacion: tagValue(blk, 'numeroAutorizacion'),
            fechaAutorizacion:  tagValue(blk, 'fechaAutorizacion'),
            ambiente:           tagValue(blk, 'ambiente'),
            comprobante:        cdataOrText(blk, 'comprobante'),
            mensajes:           parseMensajes(blk),
        });
    }
    return { autorizaciones };
}

module.exports = { enviarComprobante, autorizarComprobante };
