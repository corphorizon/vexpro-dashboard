// Separación de LECTURA y ESCRITURA en el guard de las rutas /api/admin/*.
//
// Lo que estas pruebas tienen que garantizar no es que `socio` pueda leer —eso
// es lo fácil— sino que al abrir la lectura NADIE gane escritura. Por eso la
// mitad de los casos son negativos.

import { describe, it, expect } from 'vitest';
import { puedeLlamarRuta } from './api-auth';
import { FINANCE_ROLES, HR_ROLES, WRITE_CAPABLE_ROLES, BUILT_IN_ROLES } from './roles';

const ADMIN_ROLES = ['admin', 'auditor', 'hr'];
const ESCRITURAS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Una ruta de finanzas típica: escribe finanzas, declara su módulo. */
const finanzas = (role: string, method: string) =>
  puedeLlamarRuta({ role, method, allowed: FINANCE_ROLES, declaresModules: true });

const rrhh = (role: string, method: string) =>
  puedeLlamarRuta({ role, method, allowed: HR_ROLES, declaresModules: true });

describe('leer lo decide el módulo', () => {
  it('un socio puede LEER una ruta de finanzas que declara módulo', () => {
    // Este es el bug que se arregla: antes el rol lo frenaba antes de que el
    // gate de módulos pudiera decidir, y el rol quedaba decorativo.
    expect(finanzas('socio', 'GET')).toBe(true);
  });

  it('RRHH puede LEER finanzas, y finanzas puede LEER RRHH', () => {
    expect(finanzas('hr', 'GET')).toBe(true);
    expect(rrhh('auditor', 'GET')).toBe(true);
  });

  it('todos los roles built-in pueden leer una ruta con módulo', () => {
    for (const role of BUILT_IN_ROLES) {
      expect(finanzas(role, 'GET')).toBe(true);
      expect(finanzas(role, 'HEAD')).toBe(true);
    }
  });
});

describe('escribir lo sigue decidiendo el ROL', () => {
  it('ningún rol de solo lectura escribe, en ninguna ruta ni método', () => {
    const soloLectura = BUILT_IN_ROLES.filter((r) => !WRITE_CAPABLE_ROLES.has(r));
    expect(soloLectura).toEqual(['socio', 'soporte', 'invitado']);

    for (const role of soloLectura) {
      for (const method of ESCRITURAS) {
        expect(finanzas(role, method)).toBe(false);
        expect(rrhh(role, method)).toBe(false);
        expect(
          puedeLlamarRuta({ role, method, allowed: ADMIN_ROLES, declaresModules: true }),
        ).toBe(false);
      }
    }
  });

  it('RRHH sigue sin poder escribir finanzas, y finanzas sin escribir RRHH', () => {
    // Es la segregación que pidió Kevin: Yuri y Natalia ven los números pero
    // sólo tocan Recursos Humanos.
    for (const method of ESCRITURAS) {
      expect(finanzas('hr', method)).toBe(false);
      expect(rrhh('auditor', method)).toBe(false);
    }
  });

  it('quien ya escribía sigue escribiendo', () => {
    for (const method of ESCRITURAS) {
      expect(finanzas('admin', method)).toBe(true);
      expect(finanzas('auditor', method)).toBe(true);
      expect(rrhh('admin', method)).toBe(true);
      expect(rrhh('hr', method)).toBe(true);
    }
  });
});

describe('las tres puertas que NO se abren', () => {
  it('requireAdmin gana siempre, incluso leyendo', () => {
    // El ciclo de vida de usuarios (borrar, resetear 2FA, cambiar contraseña)
    // no se relaja ni para mirar.
    for (const role of BUILT_IN_ROLES.filter((r) => r !== 'admin')) {
      expect(
        puedeLlamarRuta({ role, method: 'GET', allowed: ADMIN_ROLES, declaresModules: true, requireAdmin: true }),
      ).toBe(false);
    }
    expect(
      puedeLlamarRuta({ role: 'admin', method: 'GET', allowed: ADMIN_ROLES, declaresModules: true, requireAdmin: true }),
    ).toBe(true);
  });

  it('sin módulos declarados NO se relaja', () => {
    // Sin módulo, el gate de módulos no filtra nada: relajar el rol dejaría la
    // ruta abierta a cualquier miembro. `list-company-users` es ese caso.
    expect(
      puedeLlamarRuta({ role: 'socio', method: 'GET', allowed: ADMIN_ROLES, declaresModules: false }),
    ).toBe(false);
    expect(
      puedeLlamarRuta({ role: 'admin', method: 'GET', allowed: ADMIN_ROLES, declaresModules: false }),
    ).toBe(true);
  });

  it('sin método conocido se asume escritura', () => {
    // `api-credentials` llama a verifyAdminAuth() sin request. Sin método no
    // se puede saber si es lectura, y ante la duda manda lo estricto.
    expect(
      puedeLlamarRuta({ role: 'socio', method: null, allowed: FINANCE_ROLES, declaresModules: true }),
    ).toBe(false);
  });
});
