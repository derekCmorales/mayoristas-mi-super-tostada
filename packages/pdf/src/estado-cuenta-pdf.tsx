import React from "react";
import { render, PageNumber, TotalPages } from "takumi-pdf";
import { formatearCentavos, type EstadoCuentaPdf } from "@misupertostada/shared";
import { View, Text, StyleSheet } from "./primitives/pdf-primitives";
import { PdfcnThemeProvider } from "./theme/theme-provider";
import { miSuperTostadaTheme } from "./theme/mi-super-tostada";

/**
 * Estado de cuenta que recibe el restaurante por WhatsApp (header de documento
 * de la plantilla `ESTADO_CUENTA`). Se arma al momento del envío con las
 * facturas que tienen saldo: es el desglose que no cabe en las variables.
 *
 * Lo lee el cliente, no el equipo: nada de jerga interna, y nunca el token del
 * portal impreso (el PDF se reenvía y el token da acceso a la cuenta). El link
 * para reportar la transferencia va en el botón del mensaje.
 */

const MM = 2.83465;
const MARGEN = Math.round(12 * MM);
const MARCA = "#1B4D2A";
const MARCA_SUAVE = "#EEF3EC";
const TINTA = "#282A20";
const ACENTO = "#F2C230";
const MUTED = "#767A69";
const LINEA = "#DEDFD6";
const CEBRA = "#F7F8F3";
const PELIGRO = "#B3231C";

/** A partir de aquí la antigüedad se resalta: es lo que Cristian cobra primero. */
const DIAS_VENCIDA = 30;

const COL = {
  dte: "26%",
  monto: "19%",
  abonado: "19%",
  saldo: "19%",
  dias: "17%",
} as const;

const s = StyleSheet.create({
  page: {
    fontSize: 9,
    fontFamily: "Helvetica, Arial, sans-serif",
    color: TINTA,
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottomWidth: 1.5,
    borderBottomColor: MARCA,
    borderBottomStyle: "solid",
    paddingBottom: 8,
    marginBottom: 12,
  },
  marca: {
    fontSize: 8,
    color: MARCA,
    fontWeight: "bold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    display: "block",
  },
  titulo: { fontSize: 18, fontWeight: "bold", display: "block", marginTop: 2 },
  cliente: { fontSize: 10, display: "block", marginTop: 3 },
  metaDer: { fontSize: 7.5, color: MUTED, textAlign: "right", display: "block" },

  resumen: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
    marginBottom: 14,
  },
  kpi: {
    flexGrow: 1,
    flexBasis: 0,
    borderWidth: 0.5,
    borderColor: LINEA,
    borderStyle: "solid",
    borderRadius: 3,
    borderLeftWidth: 2.5,
    borderLeftColor: LINEA,
    borderLeftStyle: "solid",
    padding: 8,
    display: "flex",
    flexDirection: "column",
  },
  kpiMarca: {
    backgroundColor: MARCA,
    borderColor: MARCA,
    borderLeftColor: ACENTO,
  },
  kpiLabel: {
    fontSize: 6.5,
    color: MUTED,
    fontWeight: "bold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    display: "block",
  },
  kpiValor: { fontSize: 16, fontWeight: "bold", display: "block", marginTop: 3 },
  blanco: { color: "#FFFFFF" },
  blancoSuave: { color: "#DCE6DE" },

  seccion: {
    fontSize: 7,
    color: MUTED,
    fontWeight: "bold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    display: "block",
    marginBottom: 4,
  },
  fila: {
    display: "flex",
    flexDirection: "row",
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 4,
    paddingRight: 4,
    borderBottomWidth: 0.4,
    borderBottomColor: LINEA,
    borderBottomStyle: "solid",
    breakInside: "avoid",
  },
  cebra: { backgroundColor: CEBRA },
  cabecera: {
    backgroundColor: MARCA_SUAVE,
    borderBottomColor: MARCA,
  },
  th: { fontSize: 7, fontWeight: "bold", color: MARCA, display: "block" },
  num: { textAlign: "right" },
  total: {
    borderBottomWidth: 0,
    borderTopWidth: 1,
    borderTopColor: MARCA,
    borderTopStyle: "solid",
  },
  fuerte: { fontWeight: "bold" },
  vencida: { color: PELIGRO, fontWeight: "bold" },

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
    backgroundColor: MARCA_SUAVE,
    borderRadius: 3,
    padding: 8,
    display: "flex",
    flexDirection: "column",
  },
  pagoTitulo: { fontSize: 9, fontWeight: "bold", color: MARCA, display: "block" },
  pagoTexto: { fontSize: 8, display: "block", marginTop: 3, lineHeight: 1.35 },

  pie: {
    marginTop: 14,
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: MUTED,
  },
});

function dias(n: number): string {
  if (n === 0) return "Hoy";
  return n === 1 ? "1 día" : `${n} días`;
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
  const facturasTexto =
    data.facturasPendientes === 1
      ? "1 factura pendiente"
      : `${data.facturasPendientes} facturas pendientes`;

  const doc = (
    <PdfcnThemeProvider theme={miSuperTostadaTheme}>
      <View style={s.page}>
        <View style={s.header}>
          <View>
            <Text style={s.marca}>Mi Súper Tostada</Text>
            <Text style={s.titulo}>Estado de cuenta</Text>
            <Text style={s.cliente}>{data.clienteNombre}</Text>
          </View>
          <View>
            <Text style={s.metaDer}>Actualizado</Text>
            <Text style={[s.metaDer, { color: TINTA }]}>{data.generadoAt}</Text>
          </View>
        </View>

        <View style={s.resumen}>
          <View style={[s.kpi, s.kpiMarca]}>
            <Text style={[s.kpiLabel, s.blancoSuave]}>Saldo pendiente</Text>
            <Text style={[s.kpiValor, s.blanco]}>
              {formatearCentavos(data.saldoCentavos)}
            </Text>
            <Text style={[s.pagoTexto, s.blancoSuave]}>{facturasTexto}</Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Factura más antigua</Text>
            <Text
              style={
                masAntigua >= DIAS_VENCIDA ? [s.kpiValor, s.vencida] : s.kpiValor
              }
            >
              {dias(masAntigua)}
            </Text>
            <Text style={s.pagoTexto}>
              Abonado a estas facturas: {formatearCentavos(totalAbonado)}
            </Text>
          </View>
        </View>

        <Text style={s.seccion}>Detalle de facturas</Text>
        <View style={[s.fila, s.cabecera]}>
          <Text style={[s.th, { width: COL.dte }]}>Factura (DTE)</Text>
          <Text style={[s.th, s.num, { width: COL.monto }]}>Monto</Text>
          <Text style={[s.th, s.num, { width: COL.abonado }]}>Abonado</Text>
          <Text style={[s.th, s.num, { width: COL.saldo }]}>Saldo</Text>
          <Text style={[s.th, s.num, { width: COL.dias }]}>Antigüedad</Text>
        </View>
        {data.facturas.map((f, i) => (
          <View
            key={`${f.numeroDte ?? "sin-dte"}-${i}`}
            style={i % 2 === 1 ? [s.fila, s.cebra] : s.fila}
          >
            <Text style={{ width: COL.dte }}>{f.numeroDte ?? "En emisión"}</Text>
            <Text style={[s.num, { width: COL.monto }]}>
              {formatearCentavos(f.montoCentavos)}
            </Text>
            <Text style={[s.num, { width: COL.abonado }]}>
              {f.abonadoCentavos > 0 ? formatearCentavos(f.abonadoCentavos) : "—"}
            </Text>
            <Text style={[s.num, s.fuerte, { width: COL.saldo }]}>
              {formatearCentavos(f.saldoCentavos)}
            </Text>
            <Text
              style={
                f.antiguedadDias >= DIAS_VENCIDA
                  ? [s.num, s.vencida, { width: COL.dias }]
                  : [s.num, { width: COL.dias }]
              }
            >
              {dias(f.antiguedadDias)}
            </Text>
          </View>
        ))}
        <View style={[s.fila, s.total]}>
          <Text style={[s.fuerte, { width: COL.dte }]}>Total</Text>
          <Text style={[s.num, s.fuerte, { width: COL.monto }]}>
            {formatearCentavos(totalMonto)}
          </Text>
          <Text style={[s.num, s.fuerte, { width: COL.abonado }]}>
            {formatearCentavos(totalAbonado)}
          </Text>
          <Text style={[s.num, s.fuerte, { width: COL.saldo, color: MARCA }]}>
            {formatearCentavos(data.saldoCentavos)}
          </Text>
          <Text style={{ width: COL.dias }}> </Text>
        </View>

        <View style={s.pago}>
          <View style={s.pagoCaja}>
            <Text style={s.pagoTitulo}>Pago en efectivo</Text>
            <Text style={s.pagoTexto}>
              Entréguelo a nuestro repartidor en su próxima entrega. Él registra
              el pago en el momento.
            </Text>
          </View>
          <View style={s.pagoCaja}>
            <Text style={s.pagoTitulo}>Pago por transferencia</Text>
            <Text style={s.pagoTexto}>
              Después de transferir, toque «Reportar transferencia» en el mensaje
              de WhatsApp y suba la foto del comprobante desde su portal.
            </Text>
          </View>
        </View>

        <View style={s.pie}>
          <Text>
            Se muestran solo las facturas con saldo. Si ya pagó, el abono puede
            tardar en reflejarse.
          </Text>
          <Text>
            <PageNumber /> / <TotalPages />
          </Text>
        </View>
      </View>
    </PdfcnThemeProvider>
  );

  const pdfBytes = await render(doc, {
    size: "letter",
    margin: MARGEN,
    metadata: {
      title: `Estado de cuenta · ${data.clienteNombre}`,
      authors: ["Mi Súper Tostada"],
      description: `Estado de cuenta al ${data.generadoAt}`,
      creator: "Mi Súper Tostada",
    },
  });

  return Buffer.from(pdfBytes);
}
