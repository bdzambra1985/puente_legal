'use strict';

/**
 * SRI Ecuador — Generador de Clave de Acceso (49 dígitos)
 *
 * Formato (48 chars):
 *   ddMMyyyy(8) + tipoComprobante(2) + ruc(13) + ambiente(1)
 *   + estab(3) + ptoEmi(3) + secuencial(9) + codigoNumerico(8) + tipoEmision(1)
 *
 * El dígito 49 se calcula con módulo 11.
 */

/**
 * Calcula el dígito verificador por módulo 11.
 * Pesos: 2,3,4,5,6,7 (ciclando de derecha a izquierda).
 * verif = 11 - (suma % 11)
 *   Si verif === 11 → 0
 *   Si verif === 10 → 1
 *   Else → verif
 *
 * @param {string} cadena  Cadena de 48 dígitos
 * @returns {number}  dígito verificador (0-9)
 */
function modulo11(cadena) {
    const pesos = [2, 3, 4, 5, 6, 7];
    let suma = 0;
    for (let i = cadena.length - 1; i >= 0; i--) {
        const peso = pesos[(cadena.length - 1 - i) % pesos.length];
        suma += parseInt(cadena[i], 10) * peso;
    }
    const residuo = suma % 11;
    const verif = 11 - residuo;
    if (verif === 11) return 0;
    if (verif === 10) return 1;
    return verif;
}

/**
 * Genera la clave de acceso SRI de 49 dígitos.
 *
 * @param {object} opts
 * @param {string} opts.fecha         Fecha de emisión 'YYYY-MM-DD' o 'DD/MM/YYYY'
 * @param {string} opts.ruc           RUC del emisor (13 dígitos)
 * @param {string|number} opts.ambiente   1=pruebas, 2=producción
 * @param {string} opts.estab         Establecimiento (3 dígitos, ej. '001')
 * @param {string} opts.ptoEmi        Punto de emisión (3 dígitos, ej. '001')
 * @param {string|number} opts.secuencial Número secuencial (9 dígitos)
 * @param {string} [opts.tipoEmision='1']  1=normal
 * @returns {string}  Clave de acceso de 49 dígitos
 */
function generarClaveAcceso({ fecha, ruc, ambiente, estab, ptoEmi, secuencial, tipoEmision = '1' }) {
    // Normalizar fecha a ddMMyyyy
    let dd, mm, yyyy;
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        [yyyy, mm, dd] = fecha.split('-');
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) {
        [dd, mm, yyyy] = fecha.split('/');
    } else {
        throw new Error('Formato de fecha inválido. Use YYYY-MM-DD o DD/MM/YYYY');
    }

    const fechaStr       = `${dd}${mm}${yyyy}`;                // 8 chars
    const tipoComp       = '01';                                // 01 = factura
    const rucStr         = String(ruc).padStart(13, '0');       // 13 chars
    const ambienteStr    = String(ambiente);                    // 1 char
    const establStr      = String(estab).padStart(3, '0');      // 3 chars
    const ptoEmiStr      = String(ptoEmi).padStart(3, '0');     // 3 chars
    const secuencialStr  = String(secuencial).padStart(9, '0'); // 9 chars
    const codigoNum      = String(Math.floor(Math.random() * 100000000)).padStart(8, '0'); // 8 chars
    const tipoEmisionStr = String(tipoEmision);                 // 1 char

    // 48 chars total
    const base = fechaStr + tipoComp + rucStr + ambienteStr + establStr + ptoEmiStr + secuencialStr + codigoNum + tipoEmisionStr;

    if (base.length !== 48) {
        throw new Error(`Longitud incorrecta: ${base.length} chars (se esperan 48). base="${base}"`);
    }

    const digitoVerif = modulo11(base);
    return base + String(digitoVerif);
}

module.exports = { generarClaveAcceso };
