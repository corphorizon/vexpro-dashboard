// La detección tiene que encontrar la copia SIN inventarla. Por eso la mitad
// de los casos son negativos: dos cuentas que operan el mismo símbolo sin
// sincronía no son un par, y una cuenta consigo misma tampoco.

import { describe, it, expect } from 'vitest';
import { findSynchronizedPairs, type Apertura } from './copy-detection';

const T0 = Date.parse('2026-08-01T10:00:00Z');
const ap = (login: number, minuto: number, segundos = 0, simbolo = 'EURUSD', direccion = 0): Apertura => ({
  login, simbolo, direccion, cuando: T0 + minuto * 60_000 + segundos * 1000,
});

describe('encuentra la copia', () => {
  it('dos cuentas que abren lo mismo con segundos de diferencia', () => {
    const datos: Apertura[] = [];
    for (let i = 0; i < 10; i++) {
      datos.push(ap(100, i * 10));
      datos.push(ap(200, i * 10, 4)); // 4 segundos después, siempre
    }
    const [par] = findSynchronizedPairs(datos);
    expect(par).toBeDefined();
    expect(par.coincidencias).toBe(10);
    expect(par.cobertura).toBe(1);
    // El retraso típico es la huella de un copiador: constante y chico.
    expect(par.retrasoMedianoSeg).toBe(4);
  });

  it('mide la cobertura contra la cuenta MÁS CHICA', () => {
    // Si A hizo 6 y B hizo 60, que las 6 de A estén dentro de las de B es
    // copia de A. Dividir por 60 daría 10% y lo escondería.
    const datos: Apertura[] = [];
    for (let i = 0; i < 6; i++) { datos.push(ap(100, i * 10)); datos.push(ap(200, i * 10, 3)); }
    for (let i = 10; i < 64; i++) datos.push(ap(200, i * 10));
    const [par] = findSynchronizedPairs(datos);
    expect(par.cobertura).toBe(1);
    expect(Math.min(par.operacionesA, par.operacionesB)).toBe(6);
  });
});

describe('no inventa la copia', () => {
  it('el mismo símbolo pero en momentos distintos NO es un par', () => {
    // Las dos operan EURUSD 20 veces, pero siempre con 5 minutos de por medio:
    // misma operativa, ninguna sincronía. Desplazarlas una hora no serviría de
    // prueba —volverían a caer encima de las del otro lote— y de hecho fue así
    // como esta prueba falló al escribirla.
    const datos: Apertura[] = [];
    for (let i = 0; i < 20; i++) {
      datos.push(ap(100, i * 10));
      datos.push(ap(200, i * 10 + 5));
    }
    expect(findSynchronizedPairs(datos)).toHaveLength(0);
  });

  it('direcciones opuestas NO son copia', () => {
    // Uno compra y el otro vende a la vez: es cobertura o casualidad, no una
    // copia. Copiar replica la dirección.
    const datos: Apertura[] = [];
    for (let i = 0; i < 10; i++) {
      datos.push(ap(100, i * 10, 0, 'EURUSD', 0));
      datos.push(ap(200, i * 10, 2, 'EURUSD', 1));
    }
    expect(findSynchronizedPairs(datos)).toHaveLength(0);
  });

  it('una cuenta no se empareja consigo misma', () => {
    // Abrir varias seguidas es operativa propia, no copia.
    const datos = Array.from({ length: 20 }, (_, i) => ap(100, 0, i));
    expect(findSynchronizedPairs(datos)).toHaveLength(0);
  });

  it('pocas coincidencias no alcanzan aunque la cobertura sea del 100%', () => {
    // Dos operaciones sincronizadas son una casualidad, no un patrón.
    const datos = [ap(100, 0), ap(200, 0, 3), ap(100, 10), ap(200, 10, 3)];
    expect(findSynchronizedPairs(datos)).toHaveLength(0);
  });
});

describe('la cobertura nunca pasa del 100%', () => {
  it('aunque una cuenta coincida varias veces con la misma de enfrente', () => {
    // Sin el tope daría más de 1, que no significa nada y hace desconfiar de
    // todos los demás números de la tabla.
    const datos: Apertura[] = [];
    for (let i = 0; i < 6; i++) {
      datos.push(ap(100, i * 10));
      datos.push(ap(200, i * 10, 2));
      datos.push(ap(200, i * 10, 5));
      datos.push(ap(200, i * 10, 8));
    }
    for (const p of findSynchronizedPairs(datos)) expect(p.cobertura).toBeLessThanOrEqual(1);
  });
});
