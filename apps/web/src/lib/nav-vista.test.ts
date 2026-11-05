import { describe, expect, test } from "bun:test";
import { permisosPlantilla, type Rol } from "@misupertostada/shared";
import {
  esSoloLectura,
  repartirNavMovil,
  seccionInicio,
  seccionVisible,
  SECCIONES_PANEL,
  type SeccionPanel,
} from "./nav-vista";

const ROLES: readonly Rol[] = [
  "ADMIN_JEFE",
  "ADMIN",
  "PRODUCCION",
  "TIENDA",
  "REPARTO",
];

/** La jornada: la misma información, distintas acciones — si el puesto la trae. */
const NUCLEO_OPERATIVO: readonly SeccionPanel[] = [
  "hoy",
  "tablero",
  "pedidos",
  "produccion",
  "reparto",
  "cartera",
];

function visibles(rol: Rol): SeccionPanel[] {
  const permisos = permisosPlantilla(rol);
  return SECCIONES_PANEL.filter((s) => seccionVisible(s, permisos));
}

describe("visibilidad del menú por plantilla de puesto", () => {
  test("ADMIN ve las seis secciones del núcleo", () => {
    const vistas = visibles("ADMIN");
    for (const seccion of NUCLEO_OPERATIVO) {
      expect(vistas).toContain(seccion);
    }
  });

  test("mínimo privilegio: cada puesto operativo ve solo lo de su oficio", () => {
    expect(visibles("PRODUCCION")).toEqual(["produccion"]);
    expect(visibles("REPARTO")).toEqual(["reparto"]);
    expect(visibles("TIENDA")).toEqual(["pedidos", "produccion", "cartera"]);
  });

  test("sin grants no se ve ninguna sección", () => {
    expect(SECCIONES_PANEL.filter((s) => seccionVisible(s, []))).toEqual([]);
  });

  test("Catálogo, Clientes y Conversaciones siguen pidiendo su módulo", () => {
    const reparto = visibles("REPARTO");
    expect(reparto).not.toContain("catalogo");
    expect(reparto).not.toContain("conversaciones");
  });

  test("ADMIN_JEFE ve todo", () => {
    expect(visibles("ADMIN_JEFE")).toEqual([...SECCIONES_PANEL]);
  });
});

describe("badge de solo lectura", () => {
  test("PRODUCCION solo ve su hoja, que no tiene escrituras para nadie", () => {
    expect(esSoloLectura("produccion", permisosPlantilla("PRODUCCION"))).toBe(false);
  });

  test("no se marca donde el usuario sí puede actuar", () => {
    expect(esSoloLectura("reparto", permisosPlantilla("REPARTO"))).toBe(false);
    expect(esSoloLectura("cartera", permisosPlantilla("TIENDA"))).toBe(false);
    expect(esSoloLectura("pedidos", permisosPlantilla("TIENDA"))).toBe(false);
    expect(esSoloLectura("hoy", permisosPlantilla("ADMIN"))).toBe(false);
  });

  test("Tablero y Producción no se marcan: nadie escribe ahí", () => {
    for (const rol of ROLES) {
      const permisos = permisosPlantilla(rol);
      expect(esSoloLectura("tablero", permisos)).toBe(false);
      expect(esSoloLectura("produccion", permisos)).toBe(false);
    }
  });
});

describe("reparto móvil por puesto", () => {
  const items = (secciones: SeccionPanel[]) =>
    secciones.map((id) => ({
      id,
      mobile: ["tablero", "conversaciones", "catalogo", "clientes"].includes(id)
        ? false
        : undefined,
    }));

  // El orden importa cuando el jefe delega más módulos que la plantilla mínima.
  test("REPARTO prioriza Reparto y Cartera en la barra", () => {
    const { barra, extra } = repartirNavMovil(items([...NUCLEO_OPERATIVO]), "REPARTO");
    expect(barra.map((i) => i.id)).toEqual(["reparto", "cartera", "hoy"]);
    expect(extra.map((i) => i.id)).toContain("pedidos");
    expect(extra.map((i) => i.id)).toContain("tablero");
  });

  test("PRODUCCION prioriza Producción y Pedidos en la barra", () => {
    const { barra } = repartirNavMovil(items([...NUCLEO_OPERATIVO]), "PRODUCCION");
    expect(barra.map((i) => i.id)).toEqual(["produccion", "pedidos", "hoy"]);
  });

  test("ADMIN_JEFE con nueve secciones deja catálogo y clientes en extra", () => {
    const { barra, extra } = repartirNavMovil(
      items(visibles("ADMIN_JEFE")),
      "ADMIN_JEFE",
    );
    expect(barra.map((i) => i.id)).toEqual(["hoy", "pedidos", "produccion"]);
    expect(extra.map((i) => i.id)).toContain("catalogo");
    expect(extra.map((i) => i.id)).toContain("clientes");
    expect(extra.map((i) => i.id)).toContain("conversaciones");
  });

  test("cuatro o menos secciones caben todas sin botón Más", () => {
    const cuatro = items(["hoy", "pedidos", "produccion", "reparto"]);
    const { barra, extra } = repartirNavMovil(cuatro, "REPARTO");
    expect(barra).toHaveLength(4);
    expect(extra).toHaveLength(0);
  });
});

describe("sección de inicio", () => {
  test("cada puesto entra a su módulo", () => {
    expect(seccionInicio("REPARTO", permisosPlantilla("REPARTO"))).toBe("reparto");
    expect(seccionInicio("PRODUCCION", permisosPlantilla("PRODUCCION"))).toBe("produccion");
    expect(seccionInicio("TIENDA", permisosPlantilla("TIENDA"))).toBe("pedidos");
    expect(seccionInicio("ADMIN", permisosPlantilla("ADMIN"))).toBe("hoy");
    expect(seccionInicio("ADMIN_JEFE", permisosPlantilla("ADMIN_JEFE"))).toBe("hoy");
  });

  test("respeta lo delegado aunque no sea la prioridad del puesto", () => {
    expect(seccionInicio("REPARTO", ["panel.catalogo"])).toBe("catalogo");
    expect(seccionInicio("REPARTO", [])).toBe("hoy");
  });
});
