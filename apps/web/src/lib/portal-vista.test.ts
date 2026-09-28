import { describe, expect, test } from "bun:test";
import type { PortalProducto } from "@misupertostada/shared";
import {
  avisoLimiteCredito,
  cierreAnticipadoVentana,
  copyCuentaProductos,
  copyLosetaBonos,
  ctaInicio,
  ctaInicioSecundaria,
  entregaCopy,
  gruposCatalogo,
  hayBonosPendientes,
  normalizarBusqueda,
  origenPedidoLabel,
  propsVentanaCountdown,
  propsVentanaPedido,
  saludoCopy,
  vistaPedir,
  cantidadesBonoDesdePedido,
  lineasPedidoCount,
  enlacePortal,
} from "./portal-vista";

const producto = (
  partial: Partial<PortalProducto> & Pick<PortalProducto, "productoId" | "alias">,
): PortalProducto => ({
  nombreCanonico: partial.nombreCanonico ?? partial.alias,
  unidadMedida: "LIBRA",
  precioCentavos: 1250,
  favorito: false,
  familia: "TORTILLA",
  orden: 1,
  pedible: true,
  fotoAssetId: null,
  ...partial,
});

describe("saludoCopy", () => {
  test("usted + nombre", () => {
    expect(saludoCopy("tardes", "Tabasco")).toBe("Buenas tardes, Tabasco.");
    expect(saludoCopy("noches", "Casa Vieja")).toBe(
      "Buenas noches, Casa Vieja.",
    );
  });
});

describe("entregaCopy", () => {
  test("con y sin horario", () => {
    const base = {
      ventana: {
        abierta: true,
        fechaOperacion: "2026-08-21",
        fechaEntrega: "2026-08-22",
        diaEstado: "SIN_CIERRE" as const,
        cierraAt: "x".repeat(20),
        proximaAperturaAt: "y".repeat(20),
        horarioEntregaFijo: "08:30" as string | null,
      },
    };
    expect(entregaCopy(base)).toContain("a las 08:30");
    expect(
      entregaCopy({
        ventana: { ...base.ventana, horarioEntregaFijo: null },
      }),
    ).not.toContain("a las");
  });
});

describe("ctaInicio", () => {
  test("ventana abierta sin pedido → Hacer mi pedido", () => {
    expect(ctaInicio({ abierta: true, pedidoAbierto: null })).toEqual({
      kind: "pedir",
      label: "Hacer mi pedido",
    });
  });

  test("ventana abierta con pedido → editar", () => {
    const pedido = {
      id: "00000000-0000-4000-a000-000000000020",
      correlativo: 1,
      estado: "CONFIRMADO" as const,
      fechaOperacion: "2026-08-21",
      origen: "PORTAL" as const,
      items: [],
      totalCentavos: 0,
      textoConfirmacion: "x",
    };
    expect(ctaInicio({ abierta: true, pedidoAbierto: pedido }).kind).toBe(
      "editar",
    );
  });

  test("ventana cerrada → ver pedidos; secundaria catálogo", () => {
    expect(ctaInicio({ abierta: false, pedidoAbierto: null }).kind).toBe(
      "pedidos",
    );
    expect(ctaInicioSecundaria(false)?.kind).toBe("catalogo");
    expect(ctaInicioSecundaria(true)).toBeNull();
  });
});

describe("cierreAnticipadoVentana", () => {
  const base = {
    abierta: true,
    diaEstado: "SIN_CIERRE" as const,
  };

  test("true solo cuando el reloj sigue vivo y el día ya cerró", () => {
    expect(
      cierreAnticipadoVentana({ ...base, diaEstado: "CERRADO" }),
    ).toBe(true);
    expect(cierreAnticipadoVentana(base)).toBe(false);
    expect(
      cierreAnticipadoVentana({ abierta: false, diaEstado: "CERRADO" }),
    ).toBe(false);
    expect(
      cierreAnticipadoVentana({ abierta: true, diaEstado: "REABIERTO" }),
    ).toBe(false);
  });
});

describe("propsVentanaPedido", () => {
  const cerrada = {
    abierta: true,
    fechaOperacion: "2026-08-20",
    fechaEntrega: "2026-08-21",
    diaEstado: "CERRADO" as const,
    cierraAt: null,
    proximaAperturaAt: "2026-08-21T15:00:00.000-06:00",
    horarioEntregaFijo: null,
  };

  test("el badge del portal recibe los mismos bits que el navbar", () => {
    expect(propsVentanaPedido(cerrada)).toEqual({
      abierta: true,
      reabierta: false,
      diaCerrado: true,
      cierraAt: null,
      proximaAperturaAt: "2026-08-21T15:00:00.000-06:00",
    });
  });

  test("el countdown del cierre anticipado apunta a la apertura, no al cierre", () => {
    expect(propsVentanaCountdown(cerrada)).toEqual({
      cierraAt: null,
      abreAt: "2026-08-21T15:00:00.000-06:00",
    });
    expect(
      propsVentanaCountdown({
        ...cerrada,
        abierta: true,
        diaEstado: "SIN_CIERRE",
        cierraAt: "2026-08-21T03:00:00.000-06:00",
        proximaAperturaAt: null,
      }),
    ).toEqual({
      cierraAt: "2026-08-21T03:00:00.000-06:00",
      abreAt: null,
    });
  });

  test("ventana cerrada: el navbar cuenta hacia la próxima apertura", () => {
    expect(
      propsVentanaCountdown({
        ...cerrada,
        abierta: false,
        diaEstado: "SIN_CIERRE",
        cierraAt: "2026-08-21T03:00:00.000-06:00",
        proximaAperturaAt: "2026-08-21T15:00:00.000-06:00",
      }),
    ).toEqual({
      cierraAt: null,
      abreAt: "2026-08-21T15:00:00.000-06:00",
    });
  });
});

describe("avisoLimiteCredito", () => {
  test("solo cuando alcanza o supera el límite", () => {
    expect(
      avisoLimiteCredito({
        facturasPendientes: 3,
        limiteFacturasPendientes: 4,
      }),
    ).toBeNull();
    expect(
      avisoLimiteCredito({
        facturasPendientes: 4,
        limiteFacturasPendientes: 4,
      }),
    ).toMatch(/acumulación alta/);
  });
});

describe("gruposCatalogo", () => {
  const catalogo = [
    producto({
      productoId: "00000000-0000-4000-a000-000000000001",
      alias: "tortilla grande",
      favorito: true,
      familia: "TORTILLA",
    }),
    producto({
      productoId: "00000000-0000-4000-a000-000000000002",
      alias: "nachos",
      familia: "FRITURA",
      nombreCanonico: "Nachos Blancos Grandes",
    }),
    producto({
      productoId: "00000000-0000-4000-a000-000000000003",
      alias: "tostada",
      familia: "TOSTADA",
    }),
  ];

  test("favoritos arriba; resto por familia canónica", () => {
    const { favoritos, grupos } = gruposCatalogo({ catalogo });
    expect(favoritos).toHaveLength(1);
    expect(grupos.map((g) => g.key)).toEqual(["TOSTADA", "FRITURA"]);
  });

  test("filtra por alias o canónico", () => {
    const { favoritos, grupos } = gruposCatalogo({
      catalogo,
      query: "nachos blancos",
    });
    expect(favoritos).toHaveLength(0);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]?.productos[0]?.alias).toBe("nachos");
  });
});

describe("origenPedidoLabel", () => {
  test("MANUAL → Tienda", () => {
    expect(origenPedidoLabel("PORTAL")).toBe("Portal");
    expect(origenPedidoLabel("MANUAL")).toBe("Tienda");
  });
});

describe("normalizarBusqueda", () => {
  test("quita acentos, espacios de sobra y mayúsculas", () => {
    expect(normalizarBusqueda("  Tostáda  ")).toBe("tostada");
    expect(normalizarBusqueda("PAPALINAS")).toBe("papalinas");
  });

  test("el cliente escribe sin acentos y encuentra el producto acentuado", () => {
    const catalogo = [
      producto({
        productoId: "00000000-0000-4000-a000-000000000010",
        alias: "Tostáda grande",
        familia: "TOSTADA",
      }),
    ];
    const { grupos } = gruposCatalogo({ catalogo, query: "tostada" });
    expect(grupos[0]?.productos).toHaveLength(1);
  });

  test("y al revés: escribe con acento y el catálogo no lo tiene", () => {
    const catalogo = [
      producto({
        productoId: "00000000-0000-4000-a000-000000000011",
        alias: "papalinas",
        familia: "FRITURA",
      }),
    ];
    const { grupos } = gruposCatalogo({ catalogo, query: "papalínas" });
    expect(grupos[0]?.productos).toHaveLength(1);
  });
});

describe("cantidadesBonoDesdePedido", () => {
  test("solo líneas esDevolucion con bonoId", () => {
    const bonoId = "00000000-0000-4000-a000-000000000099";
    const pedido = {
      id: "00000000-0000-4000-a000-000000000020",
      correlativo: 1,
      estado: "CONFIRMADO" as const,
      fechaOperacion: "2026-08-21",
      origen: "PORTAL" as const,
      items: [
        {
          productoId: "00000000-0000-4000-a000-000000000001",
          cantidad: 5,
          esDevolucion: false,
          bonoId: null,
          nombreMostrado: "tortilla",
          unidadMedida: "LIBRA" as const,
          precioUnitarioCentavos: 1000,
        },
        {
          productoId: "00000000-0000-4000-a000-000000000001",
          cantidad: 2,
          esDevolucion: true,
          bonoId,
          nombreMostrado: "tortilla",
          unidadMedida: "LIBRA" as const,
          precioUnitarioCentavos: 0,
        },
      ],
      totalCentavos: 5000,
      textoConfirmacion: "",
    };
    expect(cantidadesBonoDesdePedido(pedido)).toEqual({ [bonoId]: 2 });
    expect(cantidadesBonoDesdePedido(null)).toEqual({});
  });
});

describe("lineasPedidoCount", () => {
  test("suma líneas pagadas y de devolución", () => {
    expect(lineasPedidoCount({ a: 2 }, { b: 1 })).toBe(2);
    expect(lineasPedidoCount({ a: 0 }, { b: 2 })).toBe(1);
    expect(lineasPedidoCount({})).toBe(0);
  });
});

describe("copyCuentaProductos", () => {
  test("incluye devoluciones en el conteo del carrito y del modal", () => {
    expect(copyCuentaProductos(0, "en-pedido")).toBe("0 productos en pedido");
    expect(copyCuentaProductos(1, "en-pedido")).toBe("1 producto en pedido");
    expect(copyCuentaProductos(2, "corto")).toBe("2 productos");
  });
});

describe("hayBonosPendientes / copyLosetaBonos", () => {
  const nachos = {
    alias: "Nachos Blancos Pequeños",
    cantidadDisponible: 2,
    unidadMedida: "BOLSA" as const,
  };
  const tortilla = {
    alias: "Tortillas #16",
    cantidadDisponible: 5,
    unidadMedida: "LIBRA" as const,
  };

  test("la loseta de inicio solo existe con saldo gratis", () => {
    expect(hayBonosPendientes([])).toBe(false);
    expect(hayBonosPendientes(undefined)).toBe(false);
    expect(hayBonosPendientes([{ cantidadDisponible: 0 }])).toBe(false);
    expect(hayBonosPendientes([{ cantidadDisponible: 2 }])).toBe(true);
    expect(copyLosetaBonos([])).toBeNull();
    expect(copyLosetaBonos([{ ...nachos, cantidadDisponible: 0 }])).toBeNull();
  });

  test("un bono: cifra en unidades y el alias", () => {
    expect(copyLosetaBonos([nachos])).toEqual({
      cifra: 2,
      etiqueta: "bolsas gratis",
      detalle: "Nachos Blancos Pequeños",
    });
  });

  test("varios: cuenta productos y desglosa", () => {
    expect(copyLosetaBonos([nachos, tortilla])).toEqual({
      cifra: 2,
      etiqueta: "productos gratis",
      detalle: "2 bolsas de Nachos Blancos Pequeños · 5 lb de Tortillas #16",
    });
  });
});

describe("vistaPedir", () => {
  const pedido = {
    id: "00000000-0000-4000-a000-000000000020",
    correlativo: 1042,
    estado: "CONFIRMADO",
    fechaOperacion: "2026-08-20",
    fechaEntrega: "2026-08-21",
    origen: "PORTAL",
    items: [],
    totalCentavos: 0,
    textoConfirmacion: "",
  } as unknown as Parameters<typeof vistaPedir>[0]["pedidoAbierto"];

  test("sin pedido abierto, el catálogo", () => {
    expect(vistaPedir({ pedidoAbierto: null, editando: false })).toBe("catalogo");
  });

  test("con pedido abierto, la confirmación", () => {
    expect(vistaPedir({ pedidoAbierto: pedido, editando: false })).toBe(
      "confirmacion",
    );
  });

  test("pidió editar: manda su intención, no el servidor", () => {
    expect(vistaPedir({ pedidoAbierto: pedido, editando: true })).toBe("catalogo");
  });

  test("un pedido que llega después (SSE o captura por teléfono) cambia la vista", () => {
    // El defecto que arregla: antes la vista se congelaba en el primer render.
    expect(vistaPedir({ pedidoAbierto: null, editando: false })).toBe("catalogo");
    expect(vistaPedir({ pedidoAbierto: pedido, editando: false })).toBe(
      "confirmacion",
    );
  });
});

describe("enlacePortal", () => {
  test("arma la URL completa sobre el origen del panel", () => {
    expect(enlacePortal("https://pedidos.misupertostada.com", "abc_123")).toBe(
      "https://pedidos.misupertostada.com/p/abc_123",
    );
  });

  test("tolera slash final en el origen y escapa el token", () => {
    expect(enlacePortal("http://localhost:3000/", "a/b")).toBe(
      "http://localhost:3000/p/a%2Fb",
    );
  });
});
