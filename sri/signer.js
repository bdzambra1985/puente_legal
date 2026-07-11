'use strict';

const forge          = require('node-forge');
const crypto         = require('crypto');
const { SignedXml }  = require('xml-crypto');
const { DOMParser }  = require('@xmldom/xmldom');

// ── Constantes ────────────────────────────────────────────────────────────
const NS_DS    = 'http://www.w3.org/2000/09/xmldsig#';
const NS_XADES = 'http://uri.etsi.org/01903/v1.3.2#';
const C14N     = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENV_SIG  = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SHA1     = `${NS_DS}sha1`;
const RSA_SHA1 = `${NS_DS}rsa-sha1`;
const XADES_SP = 'http://uri.etsi.org/01903#SignedProperties';

// ── Helpers ───────────────────────────────────────────────────────────────

function forgeBytesToBuffer(b) { return Buffer.from(b, 'binary'); }

function stripXmlDeclaration(xml) {
    return xml.replace(/^<\?xml[^?]*\?>\s*/i, '');
}

function buildIssuerDN(issuer) {
    const order = ['CN', 'OU', 'O', 'L', 'ST', 'C'];
    const parts = [];
    for (const sn of order) {
        const a = issuer.attributes.find(x => x.shortName === sn);
        if (a) parts.push(`${sn}=${a.value}`);
    }
    for (const a of issuer.attributes) {
        if (!order.includes(a.shortName))
            parts.push(`${a.shortName || a.type}=${a.value}`);
    }
    return parts.join(', ');
}

/**
 * Calcula el hash SHA-1 de la forma C14N de un nodo DOM.
 * @param {Node}     node        Nodo parseado por xmldom
 * @param {string[]} transforms  URIs de los transforms a aplicar
 * @returns {string} Base64 del digest
 */
function c14nDigest(node, transforms) {
    const sig = new SignedXml();
    const canonical = sig.getCanonXml(transforms, node);
    const buf = Buffer.isBuffer(canonical) ? canonical : Buffer.from(canonical, 'utf8');
    return crypto.createHash('sha1').update(buf).digest('base64');
}

/**
 * Parsea un fragmento XML con un contexto de namespaces del padre.
 * Devuelve el primer hijo del wrapper (el fragmento raíz).
 */
function parseInContext(fragment, nsMap) {
    const nsAttrs = Object.entries(nsMap)
        .map(([p, u]) => `xmlns:${p}="${u}"`)
        .join(' ');
    const doc = new DOMParser().parseFromString(
        `<?xml version="1.0"?><_w ${nsAttrs}>${fragment}</_w>`,
        'application/xml'
    );
    return doc.documentElement.firstChild;
}

// ── Función principal ──────────────────────────────────────────────────────

function signXML(xmlContent, p12Buffer, p12Password) {
    // 1) Parsear .p12 y extraer clave + certificado
    const p12Der  = forge.util.createBuffer(p12Buffer.toString('binary'));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, p12Password);

    const keyBags  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag   = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]
        || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];
    if (!keyBag || !keyBag[0]) throw new Error('No se encontró clave privada en el .p12');
    const privateKey = keyBag[0].key;

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    if (!certBags || !certBags.length) throw new Error('No se encontró certificado en el .p12');
    const cert = certBags[0].cert;

    if (privateKey.n.toString(16) !== cert.publicKey.n.toString(16))
        throw new Error('La clave privada no corresponde al certificado');

    // Datos del certificado de firma
    const certDer        = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
    const certBase64     = forgeBytesToBuffer(certDer.bytes()).toString('base64');
    const issuerDN       = buildIssuerDN(cert.issuer);
    const serialNumber   = BigInt('0x' + cert.serialNumber).toString(10);

    const certMd = forge.md.sha1.create();
    certMd.update(certDer.bytes());
    const certDigestB64 = forgeBytesToBuffer(certMd.digest().bytes()).toString('base64');

    // IDs únicos
    const sigId      = 'Signature-'       + Date.now();
    const sigPropsId = 'SignedProperties-' + sigId;
    const keyInfoId  = 'KeyInfo-'          + sigId;
    const sigObjId   = 'SignedObject-'     + sigId;
    const signingTime = new Date().toISOString();

    // 2) Digest del documento — C14N real sobre el XML limpio
    const xmlStripped = stripXmlDeclaration(xmlContent);
    const docElem     = new DOMParser()
        .parseFromString(xmlStripped, 'application/xml')
        .documentElement;
    const docDigestB64 = c14nDigest(docElem, [ENV_SIG, C14N]);

    // 3) SignedProperties — XML con namespaces explícitos para C14N standalone
    const signedPropsXml =
        `<xades:SignedProperties xmlns:ds="${NS_DS}" xmlns:xades="${NS_XADES}" Id="${sigPropsId}">` +
        `<xades:SignedSignatureProperties>` +
        `<xades:SigningTime>${signingTime}</xades:SigningTime>` +
        `<xades:SigningCertificate><xades:Cert>` +
        `<xades:CertDigest>` +
        `<ds:DigestMethod Algorithm="${SHA1}"></ds:DigestMethod>` +
        `<ds:DigestValue>${certDigestB64}</ds:DigestValue>` +
        `</xades:CertDigest>` +
        `<xades:IssuerSerial>` +
        `<ds:X509IssuerName>${issuerDN}</ds:X509IssuerName>` +
        `<ds:X509SerialNumber>${serialNumber}</ds:X509SerialNumber>` +
        `</xades:IssuerSerial>` +
        `</xades:Cert></xades:SigningCertificate>` +
        `</xades:SignedSignatureProperties>` +
        `</xades:SignedProperties>`;

    const signedPropsNode    = parseInContext(signedPropsXml, { ds: NS_DS, xades: NS_XADES });
    const signedPropsDigestB64 = c14nDigest(signedPropsNode, [C14N]);

    // 4) SignedInfo XML — con xmlns explícito (se parsea en contexto ds:Signature)
    const signedInfoXml =
        `<ds:SignedInfo xmlns:ds="${NS_DS}">` +
        `<ds:CanonicalizationMethod Algorithm="${C14N}"></ds:CanonicalizationMethod>` +
        `<ds:SignatureMethod Algorithm="${RSA_SHA1}"></ds:SignatureMethod>` +
        `<ds:Reference URI="#comprobante">` +
        `<ds:Transforms>` +
        `<ds:Transform Algorithm="${ENV_SIG}"></ds:Transform>` +
        `<ds:Transform Algorithm="${C14N}"></ds:Transform>` +
        `</ds:Transforms>` +
        `<ds:DigestMethod Algorithm="${SHA1}"></ds:DigestMethod>` +
        `<ds:DigestValue>${docDigestB64}</ds:DigestValue>` +
        `</ds:Reference>` +
        // Atributos en orden C14N: Type < URI
        `<ds:Reference Type="${XADES_SP}" URI="#${sigPropsId}">` +
        `<ds:DigestMethod Algorithm="${SHA1}"></ds:DigestMethod>` +
        `<ds:DigestValue>${signedPropsDigestB64}</ds:DigestValue>` +
        `</ds:Reference>` +
        `</ds:SignedInfo>`;

    // C14N del SignedInfo EN CONTEXTO de ds:Signature (para que no repita xmlns:ds)
    const signedInfoNode = parseInContext(signedInfoXml, { ds: NS_DS });
    const sig2           = new SignedXml();
    const canonSI        = sig2.getCanonXml([C14N], signedInfoNode);
    const canonSIBuf     = Buffer.isBuffer(canonSI) ? canonSI : Buffer.from(canonSI, 'utf8');

    // 5) Firmar el C14N del SignedInfo con RSA-SHA1 (SIN double-hash)
    const forgeMd = forge.md.sha1.create();
    forgeMd.update(forge.util.createBuffer(canonSIBuf).bytes());
    const signatureBytes  = privateKey.sign(forgeMd);
    const signatureValue  = forgeBytesToBuffer(signatureBytes).toString('base64');

    // 6) SignedProperties para embeber (sin xmlns, los hereda del contexto)
    const signedPropsEmbed =
        `<xades:SignedProperties Id="${sigPropsId}">` +
        `<xades:SignedSignatureProperties>` +
        `<xades:SigningTime>${signingTime}</xades:SigningTime>` +
        `<xades:SigningCertificate><xades:Cert>` +
        `<xades:CertDigest>` +
        `<ds:DigestMethod Algorithm="${SHA1}"></ds:DigestMethod>` +
        `<ds:DigestValue>${certDigestB64}</ds:DigestValue>` +
        `</xades:CertDigest>` +
        `<xades:IssuerSerial>` +
        `<ds:X509IssuerName>${issuerDN}</ds:X509IssuerName>` +
        `<ds:X509SerialNumber>${serialNumber}</ds:X509SerialNumber>` +
        `</xades:IssuerSerial>` +
        `</xades:Cert></xades:SigningCertificate>` +
        `</xades:SignedSignatureProperties>` +
        `</xades:SignedProperties>`;

    // 7) Bloque <ds:Signature> completo
    const signatureBlock =
        `<ds:Signature xmlns:ds="${NS_DS}" Id="${sigId}">\n` +
        `  ${signedInfoXml}\n` +
        `  <ds:SignatureValue Id="SignatureValue-${sigId}">${signatureValue}</ds:SignatureValue>\n` +
        `  <ds:KeyInfo Id="${keyInfoId}">\n` +
        `    <ds:X509Data>\n` +
        `      <ds:X509Certificate>${certBase64}</ds:X509Certificate>\n` +
        `    </ds:X509Data>\n` +
        `  </ds:KeyInfo>\n` +
        `  <ds:Object Id="${sigObjId}">\n` +
        `    <xades:QualifyingProperties xmlns:xades="${NS_XADES}" Target="#${sigId}">\n` +
        `      ${signedPropsEmbed}\n` +
        `    </xades:QualifyingProperties>\n` +
        `  </ds:Object>\n` +
        `</ds:Signature>`;

    if (!xmlStripped.includes('</factura>'))
        throw new Error('No se encontró </factura> en el XML');

    return xmlStripped.replace('</factura>', signatureBlock + '</factura>');
}

module.exports = { signXML };
