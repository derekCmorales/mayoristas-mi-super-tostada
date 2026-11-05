import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { permiso, usuario } from "@misupertostada/db";
import {
  PERFILES_CUENTA,
  permisosEfectivos,
  permisosPlantilla,
  PERMISO_DESCRIPCION,
  PERMISOS,
  systemClock,
} from "@misupertostada/shared";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";
import { UsuariosService } from "./usuarios.service";
import { AuditWriter } from "../shared/audit.writer";
import { DomainException } from "../shared/domain.exception";
import {
  crearOrgDePrueba,
  openTestDb,
  postgresListo,
} from "../../test/db";
import type { Actor } from "./actor";
import type { SessionCookieConfig } from "./actor";

const listo = await postgresListo();
const cookie: SessionCookieConfig = {
  name: "session",
  ttlSeconds: 3600,
  secure: false,
};

async function fixture() {
  const { client, db } = openTestDb();
  const passwords = new PasswordService();
  const sessions = new SessionService(db, systemClock, cookie);
  const audit = new AuditWriter(db);
  const auth = new AuthService(db, systemClock, passwords, sessions, audit);
  const usuarios = new UsuariosService(db, passwords, sessions, audit);

  const org = await crearOrgDePrueba(db, "org-");

  await db
    .insert(permiso)
    .values(
      PERMISOS.map((codigo) => ({
        codigo,
        descripcion: PERMISO_DESCRIPCION[codigo],
      })),
    )
    .onConflictDoNothing();

  const password = "clave-dev-local-10";
  const hash = await passwords.hash(password);
  const username = `jefe-${crypto.randomUUID().slice(0, 8)}`;
  const [jefe] = await db
    .insert(usuario)
    .values({
      organizacionId: org!.id,
      username,
      passwordHash: hash,
      rol: "ADMIN_JEFE",
      activo: true,
    })
    .returning({ id: usuario.id });

  return {
    client,
    db,
    auth,
    usuarios,
    sessions,
    passwords,
    orgId: org!.id,
    jefeId: jefe!.id,
    username,
    password,
  };
}

function actorJefe(f: Awaited<ReturnType<typeof fixture>>): Actor {
  return {
    usuarioId: f.jefeId,
    organizacionId: f.orgId,
    username: f.username,
    rol: "ADMIN_JEFE",
    permisos: permisosEfectivos("ADMIN_JEFE"),
    sesionId: crypto.randomUUID(),
    ip: "127.0.0.1",
    userAgent: "test",
  };
}

describe("SessionService cookie", () => {
  test("maxAge de la cookie es TTL en milisegundos (contrato Express)", () => {
    // Sin DB: solo verifica unidades. Un TTL de 3600s mal pasado como ms ≈ 1h de sesión en DB
    // pero cookie del navegador de ~1 minuto.
    const sessions = new SessionService(
      {} as never,
      systemClock,
      cookie,
    );
    expect(sessions.cookieOptions().maxAge).toBe(cookie.ttlSeconds * 1000);
  });
});

describe.skipIf(!listo)("AuthService", () => {
  test("login correcto emite token de sesión; el hash no es el token", async () => {
    const f = await fixture();
    try {
      const { actor, token } = await f.auth.login(
        { username: f.username, password: f.password },
        { ip: "127.0.0.1", userAgent: "test" },
      );
      expect(actor.rol).toBe("ADMIN_JEFE");
      expect(actor.permisos).toContain("precios.cambiar");
      expect(token.length).toBeGreaterThan(20);

      const resolved = await f.sessions.resolve(token);
      expect(resolved.usuarioId).toBe(f.jefeId);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("password mala, usuario inactivo y username desconocido fallan igual", async () => {
    const f = await fixture();
    try {
      const fail = (body: object) =>
        f.auth.login(body, { ip: "10.0.0.1", userAgent: "test" });

      await expect(
        fail({ username: f.username, password: "no-es" }),
      ).rejects.toBeInstanceOf(DomainException);

      await f.db
        .update(usuario)
        .set({ activo: false })
        .where(eq(usuario.id, f.jefeId));
      await expect(
        fail({ username: f.username, password: f.password }),
      ).rejects.toMatchObject({ code: "CREDENCIALES_INVALIDAS" });

      await expect(
        fail({ username: "nadie", password: f.password }),
      ).rejects.toMatchObject({ code: "CREDENCIALES_INVALIDAS" });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("logout invalida la cookie de inmediato", async () => {
    const f = await fixture();
    try {
      const { token } = await f.auth.login(
        { username: f.username, password: f.password },
        { ip: "127.0.0.1", userAgent: "test" },
      );
      const resolved = await f.sessions.resolve(token);
      await f.auth.logout(token, { ip: "127.0.0.1", userAgent: "test" }, {
        ...actorJefe(f),
        sesionId: resolved.sesionId,
      });
      await expect(f.sessions.resolve(token)).rejects.toMatchObject({
        code: "SESION_REQUERIDA",
      });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});

describe.skipIf(!listo)("UsuariosService", () => {
  test("ADMIN_JEFE delega precios.cambiar y no puede delegar ventana.reabrir", async () => {
    const f = await fixture();
    try {
      const jefe = actorJefe(f);
      const creado = await f.usuarios.crear(
        {
          username: `admin-${crypto.randomUUID().slice(0, 8)}`,
          password: "clave-dev-local-10",
          rol: "ADMIN",
        },
        jefe,
      );
      expect(creado.permisos).not.toContain("precios.cambiar");
      expect(creado.permisos).toContain("panel.hoy");

      const conPrecio = await f.usuarios.delegar(
        creado.id,
        { codigo: "precios.cambiar", granted: true },
        jefe,
      );
      expect(conPrecio.permisos).toContain("precios.cambiar");

      await expect(
        f.usuarios.delegar(
          creado.id,
          { codigo: "ventana.reabrir", granted: true },
          jefe,
        ),
      ).rejects.toMatchObject({ code: "PERMISO_NO_DELEGABLE" });

      const sinCartera = await f.usuarios.delegarModulo(
        creado.id,
        { modulo: "cartera", granted: false },
        jefe,
      );
      expect(sinCartera.permisos).not.toContain("panel.cartera");
      expect(sinCartera.permisos).not.toContain("cobranza.registrar_pago");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("atajos por puesto: solo con el rol se siembra exactamente la plantilla mínima", async () => {
    const f = await fixture();
    try {
      const jefe = actorJefe(f);
      for (const perfil of PERFILES_CUENTA) {
        const creado = await f.usuarios.crear(
          {
            username: `${perfil.usuarioBase}-${crypto.randomUUID().slice(0, 8)}`,
            password: "k7mqp-3xh9d-wz2ra",
            rol: perfil.rol,
          },
          jefe,
        );
        expect([...creado.permisos].sort()).toEqual(
          [...permisosPlantilla(perfil.rol)].sort(),
        );
      }
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("listar incluye activo; activar, reset de clave y no se desactiva el último jefe", async () => {
    const f = await fixture();
    try {
      const jefe = actorJefe(f);
      const creado = await f.usuarios.crear(
        {
          username: `admin-${crypto.randomUUID().slice(0, 8)}`,
          password: "clave-dev-local-10",
          rol: "ADMIN",
        },
        jefe,
      );
      expect(creado.activo).toBe(true);
      const list = await f.usuarios.listar(f.orgId);
      expect(list.find((u) => u.id === creado.id)?.activo).toBe(true);

      await f.usuarios.desactivar(creado.id, jefe);
      const inactivos = await f.usuarios.listar(f.orgId);
      expect(inactivos.find((u) => u.id === creado.id)?.activo).toBe(false);

      const reactivado = await f.usuarios.activar(
        creado.id,
        { activo: true },
        jefe,
      );
      expect(reactivado.activo).toBe(true);

      await f.usuarios.resetPassword(
        creado.id,
        { password: "nueva-clave-10" },
        jefe,
      );

      await expect(
        f.usuarios.cambiarRol(f.jefeId, { rol: "ADMIN" }, jefe),
      ).rejects.toMatchObject({ code: "ULTIMO_ADMIN_JEFE" });
      await expect(f.usuarios.desactivar(f.jefeId, jefe)).rejects.toMatchObject({
        code: "VALIDACION",
      });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
