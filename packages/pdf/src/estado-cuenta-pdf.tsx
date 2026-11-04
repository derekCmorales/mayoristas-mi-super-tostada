import React from "react";
import { render, PageNumber, TotalPages } from "takumi-pdf";
import { formatearCentavos, type EstadoCuentaPdf } from "@misupertostada/shared";
import { View, Text, Image, StyleSheet } from "./primitives/pdf-primitives";
import { PdfcnThemeProvider } from "./theme/theme-provider";
import { miSuperTostadaTheme } from "./theme/mi-super-tostada";
import { FUENTE, FUENTES_MARCA, IMAGENES_MARCA, LOGO_SRC, TOKENS as T } from "./marca";

/**
 * Estado de cuenta que recibe el restaurante por WhatsApp (header de documento
 * de la plantilla `ESTADO_CUENTA`). Se arma al momento del envío con las
 * facturas que tienen saldo: es el desglose que no cabe en las variables.
 *
 * Lo lee el cliente, no el equipo: lenguaje del portal, sin jerga interna, y
 * nunca el token del portal impreso (el PDF se reenvía y el token da acceso a
 * la cuenta). El link para reportar la transferencia va en el botón del mensaje.
 */

const MM = 2.83465;
const MARGEN = Math.round(12 * MM);

/** Desde aquí la factura se marca vencida: es lo que Cristian cobra primero. */
const DIAS_VENCIDA = 30;

const COL = {
  dte: "24%",
  monto: "16%",
  abonado: "16%",
  saldo: "17%",
  dias: "12%",
  estado: "15%",
} as const;

const s = StyleSheet.create({
  page: {
    fontSize: 9,
    fontFamily: FUENTE,
    color: T.ink800,
    display: "flex",
    flexDirection: "column",
  },

  /* Encabezado: banda de marca con el riel amarillo del nav. */
  banda: {
    backgroundColor: T.green900,
    borderRadius: 12,
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 14,
    paddingRight: 16,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  logoAro: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: T.white,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  logo: { width: 54, height: 54 },
  bandaTexto: { flexGrow: 1, display: "flex", flexDirection: "column" },
  eyebrow: {
    fontSize: 7,
    fontWeight: 800,
    color: T.yellow400,
    textTransform: "uppercase",
    letterSpacing: 1,
    display: "block",
  },
  titulo: {
    fontSize: 20,
    fontWeight: 800,
    color: T.white,
    display: "block",
    marginTop: 1,
  },
  cliente: { fontSize: 10.5, color: T.green200, display: "block", marginTop: 1 },
  fechaCaja: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  fechaLabel: { fontSize: 7, color: T.green200, display: "block" },
  fecha: { fontSize: 8.5, fontWeight: 700, color: T.white, display: "block" },
  riel: {
    height: 3,
    backgroundColor: T.yellow400,
    borderRadius: 2,
    marginTop: 4,
    marginLeft: 24,
    marginRight: 24,
    marginBottom: 14,
  },

  /* Resumen */
  resumen: { display: "flex", flexDirection: "row", gap: 8, marginBottom: 14 },
  kpi: {
    flexGrow: 1,
    flexBasis: 0,
    backgroundColor: T.white,
    borderWidth: 1,
    borderColor: T.ink200,
    borderStyle: "solid",
    borderRadius: 12,
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: 12,
    paddingRight: 12,
    display: "flex",
    flexDirection: "column",
  },
  kpiMarca: {
    flexGrow: 1.4,
    backgroundColor: T.green800,
    borderColor: T.green800,
    borderLeftWidth: 4,
    borderLeftColor: T.yellow400,
  },
  kpiLabel: {
    fontSize: 7,
    fontWeight: 800,
    color: T.ink500,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    display: "block",
  },
  kpiValor: {
    fontSize: 18,
    fontWeight: 800,
    color: T.ink900,
    display: "block",
    marginTop: 3,
  },
  kpiNota: { fontSize: 8, color: T.ink500, display: "block", marginTop: 2 },
  enMarca: { color: T.white },
  enMarcaSuave: { color: T.green200 },
  peligro: { color: T.red700 },

  /* Tabla dentro de una tarjeta */
  seccion: {
    fontSize: 7.5,
    fontWeight: 800,
    color: T.green800,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    display: "block",
    marginBottom: 6,
  },
  tarjeta: {
    borderWidth: 1,
    borderColor: T.ink200,
    borderStyle: "solid",
    borderRadius: 12,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  fila: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 10,
    paddingRight: 10,
    borderTopWidth: 1,
    borderTopColor: T.ink100,
    borderTopStyle: "solid",
    breakInside: "avoid",
  },
  cabecera: { backgroundColor: T.ink50, borderTopWidth: 0 },
  th: {
    fontSize: 7,
    fontWeight: 800,
    color: T.ink500,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    display: "block",
  },
  td: { fontSize: 9, display: "block" },
  num: { textAlign: "right" },
  dte: { fontWeight: 700, color: T.ink900 },
  saldo: { fontWeight: 800, color: T.ink900 },
  sutil: { color: T.ink500 },
  total: {
    backgroundColor: T.green50,
    borderTopWidth: 1.5,
    borderTopColor: T.green800,
  },
  totalTexto: { fontWeight: 800, color: T.green800 },
  badgeCaja: { display: "flex", flexDirection: "row", justifyContent: "flex-end" },
  badge: {
    fontSize: 7,
    fontWeight: 800,
    borderRadius: 999,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 7,
    paddingRight: 7,
    display: "block",
  },

  /* Cómo pagar: papel crema, como los paneles de pago del portal */
  pago: {
    marginTop: 16,
    display: "flex",
    flexDirection: "row",
    gap: 8,
    breakInside: "avoid",
  },
  pagoCaja: {
    flexGrow: 1,
    flexBasis: 0,
    backgroundColor: T.cream300,
    borderRadius: 12,
    paddingTop: 10,
    paddingBottom: 11,
    paddingLeft: 12,
    paddingRight: 12,
    display: "flex",
    flexDirection: "row",
    gap: 9,
  },
  paso: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: T.yellow400,
    color: T.green900,
    fontSize: 9,
    fontWeight: 800,
    textAlign: "center",
    paddingTop: 2,
    display: "block",
  },
  pagoCuerpo: { flexGrow: 1, flexBasis: 0, display: "flex", flexDirection: "column" },
  pagoTitulo: { fontSize: 10, fontWeight: 800, color: T.green800, display: "block" },
  pagoTexto: {
    fontSize: 8.5,
    color: T.ink600,
    display: "block",
    marginTop: 3,
    lineHeight: 1.4,
  },

  pie: {
    marginTop: 16,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: T.ink200,
    borderTopStyle: "solid",
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: T.ink500,
  },
  lema: { fontWeight: 700, color: T.green700 },
});

function dias(n: number): string {
  if (n === 0) return "Hoy";
  return n === 1 ? "1 día" : `${n} días`;
}

type Badge = { texto: string; bg: string; fg: string };

/** Mismos pares bg/fg que `--estado-*` del panel. */
function estadoFactura(f: EstadoCuentaPdf["facturas"][number]): Badge {
  if (f.antiguedadDias >= DIAS_VENCIDA) {
    return { texto: "Vencida", bg: T.red100, fg: T.red700 };
  }
  if (f.abonadoCentavos > 0) {
    return { texto: "Con abono", bg: T.blue100, fg: T.blue700 };
  }
  return { texto: "Pendiente", bg: T.amber100, fg: T.amber700 };
}

export async function renderEstadoCuentaPdf(
  data: EstadoCuentaPdf,
): Promise<Buffer> {
  const totalMonto = data.facturas.reduce((acc, f) => acc + f.montoCentavos, 0);
  const totalAbonado = data.facturas.reduce((acc, f) => acc + f.abonadoCentavos, 0);
  const masAntigua = data.facturas.reduce(
    (acc, f) => Math.max(acc, f.antiguedadDias),
    0,
  );
  const vencidas = data.facturas.filter((f) => f.antiguedadDias >= DIAS_VENCIDA).length;

  const doc = (
    <PdfcnThemeProvider theme={miSuperTostadaTheme}>
      <View style={s.page}>
        <View style={s.banda}>
          <View style={s.logoAro}>
            <Image src={LOGO_SRC} style={s.logo} />
          </View>
          <View style={s.bandaTexto}>
            <Text style={s.eyebrow}>Mi Súper Tostada</Text>
            <Text style={s.titulo}>Estado de cuenta</Text>
            <Text style={s.cliente}>{data.clienteNombre}</Text>
          </View>
          <View style={s.fechaCaja}>
            <Text style={s.fechaLabel}>Actualizado</Text>
            <Text style={s.fecha}>{data.generadoAt}</Text>
          </View>
        </View>
        <View style={s.riel} />

        <View style={s.resumen}>
          <View style={[s.kpi, s.kpiMarca]}>
            <Text style={[s.kpiLabel, s.enMarcaSuave]}>Saldo pendiente</Text>
            <Text style={[s.kpiValor, s.enMarca, { fontSize: 22 }]}>
              {formatearCentavos(data.saldoCentavos)}
            </Text>
            <Text style={[s.kpiNota, s.enMarcaSuave]}>
              Abonado a estas facturas: {formatearCentavos(totalAbonado)}
            </Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Facturas</Text>
            <Text style={s.kpiValor}>{data.facturasPendientes}</Text>
            <Text style={s.kpiNota}>
              con saldo pendiente
            </Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Más antigua</Text>
            <Text style={masAntigua >= DIAS_VENCIDA ? [s.kpiValor, s.peligro] : s.kpiValor}>
              {dias(masAntigua)}
            </Text>
            <Text style={vencidas > 0 ? [s.kpiNota, s.peligro] : s.kpiNota}>
              {vencidas > 0
                ? `${vencidas} vencida${vencidas === 1 ? "" : "s"}`
                : "Al día"}
            </Text>
          </View>
        </View>

        <Text style={s.seccion}>Detalle de facturas</Text>
        <View style={s.tarjeta}>
          <View style={[s.fila, s.cabecera]}>
            <Text style={[s.th, { width: COL.dte }]}>Factura (DTE)</Text>
            <Text style={[s.th, s.num, { width: COL.monto }]}>Monto</Text>
            <Text style={[s.th, s.num, { width: COL.abonado }]}>Abonado</Text>
            <Text style={[s.th, s.num, { width: COL.saldo }]}>Saldo</Text>
            <Text style={[s.th, s.num, { width: COL.dias }]}>Días</Text>
            <Text style={[s.th, s.num, { width: COL.estado }]}>Estado</Text>
          </View>
          {data.facturas.map((f, i) => {
            const badge = estadoFactura(f);
            return (
              <View key={`${f.numeroDte ?? "sin-dte"}-${i}`} style={s.fila}>
                <Text style={[s.td, s.dte, { width: COL.dte }]}>
                  {f.numeroDte ?? "En emisión"}
                </Text>
                <Text style={[s.td, s.num, { width: COL.monto }]}>
                  {formatearCentavos(f.montoCentavos)}
                </Text>
                <Text
                  style={
                    f.abonadoCentavos > 0
                      ? [s.td, s.num, { width: COL.abonado }]
                      : [s.td, s.num, s.sutil, { width: COL.abonado }]
                  }
                >
                  {f.abonadoCentavos > 0 ? formatearCentavos(f.abonadoCentavos) : "—"}
                </Text>
                <Text style={[s.td, s.num, s.saldo, { width: COL.saldo }]}>
                  {formatearCentavos(f.saldoCentavos)}
                </Text>
                <Text style={[s.td, s.num, s.sutil, { width: COL.dias }]}>
                  {dias(f.antiguedadDias)}
                </Text>
                <View style={[s.badgeCaja, { width: COL.estado }]}>
                  <Text style={[s.badge, { backgroundColor: badge.bg, color: badge.fg }]}>
                    {badge.texto}
                  </Text>
                </View>
              </View>
            );
          })}
          <View style={[s.fila, s.total]}>
            <Text style={[s.td, s.totalTexto, { width: COL.dte }]}>Total</Text>
            <Text style={[s.td, s.num, s.totalTexto, { width: COL.monto }]}>
              {formatearCentavos(totalMonto)}
            </Text>
            <Text style={[s.td, s.num, s.totalTexto, { width: COL.abonado }]}>
              {formatearCentavos(totalAbonado)}
            </Text>
            <Text style={[s.td, s.num, s.totalTexto, { width: COL.saldo }]}>
              {formatearCentavos(data.saldoCentavos)}
            </Text>
            <Text style={{ width: COL.dias }}> </Text>
            <Text style={{ width: COL.estado }}> </Text>
          </View>
        </View>

        <Text style={[s.seccion, { marginTop: 16 }]}>Cómo pagar</Text>
        <View style={[s.pago, { marginTop: 0 }]}>
          <View style={s.pagoCaja}>
            <Text style={s.paso}>1</Text>
            <View style={s.pagoCuerpo}>
              <Text style={s.pagoTitulo}>En efectivo</Text>
              <Text style={s.pagoTexto}>
                Entrégueselo a nuestro repartidor en su próxima entrega. Él
                registra el pago en el momento.
              </Text>
            </View>
          </View>
          <View style={s.pagoCaja}>
            <Text style={s.paso}>2</Text>
            <View style={s.pagoCuerpo}>
              <Text style={s.pagoTitulo}>Por transferencia</Text>
              <Text style={s.pagoTexto}>
                Después de transferir, toque «Reportar transferencia» en el
                mensaje de WhatsApp y suba la foto del comprobante.
              </Text>
            </View>
          </View>
        </View>

        <View style={s.pie}>
          <Text>
            <Text style={s.lema}>¡Un concepto diferente de comer maíz! </Text>
            Se muestran solo las facturas con saldo.
          </Text>
          <Text>
            Página <PageNumber /> de <TotalPages />
          </Text>
        </View>
      </View>
    </PdfcnThemeProvider>
  );

  const pdfBytes = await render(doc, {
    size: "letter",
    margin: MARGEN,
    fonts: FUENTES_MARCA,
    fontFamilies: [FUENTE, "sans-serif"],
    images: IMAGENES_MARCA,
    metadata: {
      title: `Estado de cuenta · ${data.clienteNombre}`,
      authors: ["Mi Súper Tostada"],
      description: `Estado de cuenta al ${data.generadoAt}`,
      creator: "Mi Súper Tostada",
    },
  });

  return Buffer.from(pdfBytes);
}
