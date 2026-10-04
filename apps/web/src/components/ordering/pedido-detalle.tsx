"use client";

import {
  Alert,
  Button,
  Card,
  Chip,
  ComboBox,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Phone, Pin, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  horaEnZona,
  PAGO_METODO_ETIQUETA,
  precioEfectivoCentavos,
  totalPedidoCentavos,
  type ClienteProductoFila,
  type PedidoDetalle as PedidoDetalleDto,
  type ProductoPublico,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import {
  debeAplicarSnapshotServidor,
  productosAgregables,
} from "@/lib/pedido-vista";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { ClienteAvatar } from "@/components/catalog/cliente-avatar";
import { EstadoBadge } from "@/components/domain/estado-badge";
import { Money } from "@/components/domain/money";
import { PedidoItemRow } from "@/components/domain/pedido-item-row";
import { etiquetaDiaSemanaCorto } from "@/lib/fecha-ui";
import { DialogoCapturaDte } from "@/components/receivables/dialogo-captura-dte";
import { BotonDte } from "@/components/receivables/boton-dte";
import { ComprobanteAssetPreview } from "@/components/receivables/comprobante-asset-preview";
import { DialogoAjustePrecios } from "@/components/ordering/dialogo-ajuste-precios";

const ACCION_TEXTO: Record<string, string> = {
  "portal.confirmar": "capturó el pedido desde el portal",
  "portal.editar": "editó el pedido desde el portal",
  "pedidos.capturar": "capturó el pedido",
  "pedidos.editar_items": "ajustó los ítems",
  "pedidos.notas": "actualizó las notas del administrador",
  "pedidos.anular": "anuló el pedido",
  "pedidos.ajustar_precios": "corrigió precios",
};

type ItemLocal = {
  productoId: string;
  cantidad: number;
  nombreMostrado: string;
  nombreCanonico: string;
  unidadMedida: PedidoDetalleDto["items"][number]["unidadMedida"];
  precioUnitarioCentavos: number;
  puntoCarga?: PedidoDetalleDto["items"][number]["puntoCarga"];
  notaProduccion?: string | null;
  esDevolucion: boolean;
  bonoId?: string | null;
};

export function PedidoDetalle({
  pedido,
  puedeEscribir,
  puedeDte,
  puedeCambiarPrecio = false,
  fotoAssetId,
}: {
  pedido: PedidoDetalleDto;
  puedeEscribir: boolean;
  puedeDte: boolean;
  /** `precios.cambiar`: corregir precios aunque el día esté cerrado o entregado. */
  puedeCambiarPrecio?: boolean;
  fotoAssetId?: string | null;
}) {
  const qc = useQueryClient();
  const editable = puedeEscribir && pedido.estado === "CONFIRMADO";
  const [items, setItems] = useState<ItemLocal[]>(() => mapItems(pedido));
  const [notas, setNotas] = useState(pedido.notasAdmin ?? "");
  const [anular, setAnular] = useState(false);
  const [dteAbierto, setDteAbierto] = useState(false);
  const [ajustePrecios, setAjustePrecios] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [agregarId, setAgregarId] = useState("");
  const pedidoIdRef = useRef(pedido.id);
  const userEditedRef = useRef(false);
  // El baseline se compara DURANTE el render para calcular `dirty`, así que
  // es estado, no ref: leer un ref en render no es seguro con renders
  // concurrentes y deja la UI mostrando un «sin cambios» viejo.
  const [baseline, setBaseline] = useState(() => ({
    items: mapItems(pedido),
    notas: pedido.notasAdmin ?? "",
  }));

  const itemsDirty = !mismoItemsLocal(items, baseline.items);
  const notasDirty = notas !== baseline.notas;
  const dirty = itemsDirty || notasDirty;

  useEffect(() => {
    const aplicar = debeAplicarSnapshotServidor({
      pedidoIdLocal: pedidoIdRef.current,
      pedidoIdServidor: pedido.id,
      dirty: userEditedRef.current,
    });
    pedidoIdRef.current = pedido.id;
    if (!aplicar) return;
    const nextItems = mapItems(pedido);
    const nextNotas = pedido.notasAdmin ?? "";
    setBaseline({ items: nextItems, notas: nextNotas });
    userEditedRef.current = false;
    setItems(nextItems);
    setNotas(nextNotas);
    setError(null);
    setAgregarId("");
  }, [pedido]);

  const productos = useQuery({
    queryKey: ["productos"],
    queryFn: () => api<ProductoPublico[]>("/productos"),
  });
  const catalogoCliente = useQuery({
    queryKey: ["clientes", pedido.clienteId, "productos"],
    queryFn: () =>
      api<ClienteProductoFila[]>(`/clientes/${pedido.clienteId}/productos`),
    enabled: editable,
  });

  const fotoPorProducto = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const p of productos.data ?? []) map.set(p.id, p.fotoAssetId);
    return map;
  }, [productos.data]);

  const agregables = useMemo(
    () =>
      productosAgregables(
        catalogoCliente.data ?? [],
        new Set(items.filter((i) => !i.esDevolucion).map((i) => i.productoId)),
      ),
    [catalogoCliente.data, items],
  );

  const total = totalPedidoCentavos(
    items.map((item) => ({
      cantidad: item.cantidad,
      precioUnitarioCentavos: item.precioUnitarioCentavos,
    })),
  );

  const guardar = useMutation({
    mutationFn: async () => {
      if (itemsDirty) {
        await api<PedidoDetalleDto>(`/pedidos/${pedido.id}/items`, {
          method: "PATCH",
          body: JSON.stringify({
            items: items.map((item) => ({
              productoId: item.productoId,
              cantidad: item.cantidad,
              esDevolucion: item.esDevolucion,
              ...(item.bonoId ? { bonoId: item.bonoId } : {}),
            })),
          }),
        });
      }
      if (notasDirty) {
        await api<PedidoDetalleDto>(`/pedidos/${pedido.id}/notas`, {
          method: "PATCH",
          body: JSON.stringify({ notasAdmin: notas }),
        });
      }
    },
    onSuccess: () => {
      setBaseline({ items: [...items], notas });
      userEditedRef.current = false;
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      setError(null);
      toastSuccess("Cambios guardados");
    },
    onError: (err) => {
      // Si falló el segundo PATCH, el primero pudo haber quedado en servidor.
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      const msg =
        err instanceof ApiError ? err.message : "No se pudieron guardar los cambios";
      setError(msg);
      toastFromError(err, "No se pudieron guardar los cambios");
    },
  });

  const anularPedido = useMutation({
    mutationFn: () =>
      api<PedidoDetalleDto>(`/pedidos/${pedido.id}/anular`, {
        method: "POST",
        body: JSON.stringify({ motivo }),
      }),
    onSuccess: () => {
      setAnular(false);
      setMotivo("");
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      toastSuccess("Pedido anulado");
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "No se pudo anular");
      toastFromError(err, "No se pudo anular");
    },
  });

  const dte = useMutation({
    mutationFn: ({ id, numeroDte }: { id: string; numeroDte: string }) =>
      api(`/facturas/${id}/dte`, {
        method: "PATCH",
        body: JSON.stringify({ numeroDte }),
      }),
    onSuccess: () => {
      setDteAbierto(false);
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      void qc.invalidateQueries({ queryKey: ["cartera"] });
      toastSuccess("DTE guardado");
    },
    onError: (err) => toastFromError(err, "No se pudo guardar el DTE"),
  });

  const hintDte = `Capturar DTE del pedido #${pedido.correlativo}`;

  const puedeAjustarPrecios =
    puedeCambiarPrecio && pedido.estado !== "ANULADO";
  // Solo antes de entregar: un pedido viejo contra el catálogo de hoy siempre
  // «difiere» después de una subida normal, y ahí no hay nada que corregir.
  const pendienteDeEntregar =
    pedido.estado === "CONFIRMADO" || pedido.estado === "EN_PRODUCCION";
  const lineasFueraDeCatalogo = pedido.items.filter(
    (i) =>
      pendienteDeEntregar &&
      !i.esDevolucion &&
      i.precioCatalogoCentavos != null &&
      i.precioCatalogoCentavos !== i.precioUnitarioCentavos,
  ).length;

  const hora = horaEnZona(new Date(pedido.capturadoAt));
  const origenLabel = pedido.origen === "PORTAL" ? "Portal" : "Manual";
  const tel = pedido.clienteTelefonoWa?.replace(/\D/g, "") ?? "";

  function agregarProducto(productoId: string) {
    const fila = agregables.find((f) => f.productoId === productoId);
    const precio = fila
      ? precioEfectivoCentavos({
          precioClienteCentavos: fila.precioCentavos,
          precioBaseCentavos: fila.precioBaseCentavos,
        })
      : null;
    if (!fila || precio == null) return;
    userEditedRef.current = true;
    setItems((prev) => [
      ...prev,
      {
        productoId: fila.productoId,
        cantidad: 1,
        nombreMostrado: fila.alias?.trim() || fila.nombreCanonico,
        nombreCanonico: fila.nombreCanonico,
        unidadMedida: fila.unidadMedida,
        precioUnitarioCentavos: precio,
        puntoCarga: fila.puntoCarga,
        notaProduccion: fila.notaProduccion,
        esDevolucion: false,
        bonoId: null,
      },
    ]);
    setAgregarId("");
  }

  return (
    <div className="grid gap-4">
      <Card className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <ClienteAvatar
            nombre={pedido.clienteNombre}
            fotoAssetId={fotoAssetId}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-pretty text-tinta-900">
                <Link
                  href={`/clientes/${pedido.clienteId}`}
                  className="text-inherit no-underline hover:text-marca hover:no-underline"
                >
                  {pedido.clienteNombre}
                </Link>
              </h2>
              <EstadoBadge estado={pedido.estado} />
              <Chip
                color={pedido.origen === "PORTAL" ? "success" : "warning"}
                size="sm"
                variant="soft"
              >
                {origenLabel}
              </Chip>
            </div>
            <p className="mt-1 text-xs text-tinta-500">
              Pedido{" "}
              <span className="font-mono tabular-nums">#{pedido.correlativo}</span>
              {" · "}
              capturado {hora}
              {pedido.capturadoPorNombre
                ? ` por ${pedido.capturadoPorNombre}`
                : ""}
            </p>
            {/*
              La hora de captura no dice a qué operación pertenece el pedido:
              lo capturado a las 02:00 es de la ventana del día anterior. Las
              dos fechas del dominio van escritas y separadas, porque la de
              entrega está congelada y es la que se le dice al cliente.
            */}
            <p className="mt-0.5 text-xs tabular-nums text-tinta-500">
              Operación {etiquetaDiaSemanaCorto(pedido.fechaOperacion)} · entrega{" "}
              <span className="font-semibold text-[var(--amber-700)]">
                {etiquetaDiaSemanaCorto(pedido.fechaEntrega)}
              </span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-tinta-500">
              {pedido.horarioEntregaFijo && (
                <Chip color="success" size="sm" variant="soft">
                  <Clock size={13} aria-hidden />
                  Entrega fija {pedido.horarioEntregaFijo}
                </Chip>
              )}
              {pedido.clienteContacto && <span>{pedido.clienteContacto}</span>}
              {pedido.clienteTelefonoWa && (
                <a
                  href={tel ? `tel:+${tel}` : undefined}
                  className="inline-flex min-h-11 items-center gap-1 font-semibold text-marca no-underline hover:text-marca-hover"
                  aria-label={`Llamar a ${pedido.clienteNombre}`}
                >
                  <Phone size={13} aria-hidden />
                  {pedido.clienteTelefonoWa}
                </a>
              )}
            </div>
            {pedido.notasPermanentes && (
              <div className="mt-2">
                <Chip color="success" size="sm" variant="soft">
                  <Pin size={13} aria-hidden />
                  {pedido.notasPermanentes}
                </Chip>
              </div>
            )}
            {pedido.estado === "ANULADO" && pedido.motivoAnulacion && (
              <Alert className="mt-3" status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>Pedido anulado</Alert.Title>
                  <Alert.Description>{pedido.motivoAnulacion}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}
          </div>
          {editable && (
            <Button
              className="w-full shrink-0 sm:w-auto"
              size="sm"
              variant="danger-soft"
              onPress={() => setAnular(true)}
            >
              Anular
            </Button>
          )}
        </div>
      </Card>

      <Card className="gap-0 overflow-hidden p-0">
        <Card.Header className="p-5 pb-3">
          <Card.Title className="text-base text-tinta-900">Ítems</Card.Title>
          <Card.Description>
            Precio y nombre quedan en snapshot al capturar
          </Card.Description>
          {puedeAjustarPrecios ? (
            <Button
              className="mt-2 w-full sm:w-auto"
              isDisabled={dirty}
              size="sm"
              variant="secondary"
              onPress={() => setAjustePrecios(true)}
            >
              Corregir precios
            </Button>
          ) : null}
        </Card.Header>
        {puedeAjustarPrecios && lineasFueraDeCatalogo > 0 ? (
          <Alert className="mx-5 mb-3" status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {lineasFueraDeCatalogo === 1
                  ? "Una línea tiene un precio distinto al catálogo actual"
                  : `${lineasFueraDeCatalogo} líneas tienen un precio distinto al catálogo actual`}
              </Alert.Title>
              <Alert.Description>
                El pedido cobra el precio con que se capturó. Si se tomó con un
                precio equivocado, corríjalo con «Corregir precios».
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <Card.Content className="border-t border-[var(--border-subtle)] p-0">
          {items.map((item) => (
            <PedidoItemRow
              key={`${item.productoId}-${item.esDevolucion ? "d" : "p"}-${item.bonoId ?? ""}`}
              nombreMostrado={item.nombreCanonico}
              alias={item.nombreMostrado}
              unidadMedida={item.unidadMedida}
              cantidad={item.cantidad}
              precioUnitarioCentavos={item.precioUnitarioCentavos}
              puntoCarga={item.puntoCarga}
              notaProduccion={item.notaProduccion}
              fotoAssetId={fotoPorProducto.get(item.productoId)}
              esDevolucion={item.esDevolucion}
              editable={editable}
              onChangeCantidad={(v) => {
                userEditedRef.current = true;
                setItems((prev) =>
                  prev.map((row) =>
                    row.productoId === item.productoId &&
                    row.esDevolucion === item.esDevolucion &&
                    (row.bonoId ?? null) === (item.bonoId ?? null)
                      ? { ...row, cantidad: v }
                      : row,
                  ),
                );
              }}
            />
          ))}
          {editable && agregables.length > 0 ? (
            <div className="flex flex-col gap-2 border-b border-[var(--border-subtle)] px-4 py-3 sm:flex-row sm:flex-wrap sm:items-end">
              <ComboBox
                className="min-w-0 w-full flex-1"
                selectedKey={agregarId || null}
                onSelectionChange={(key) =>
                  setAgregarId(typeof key === "string" ? key : "")
                }
              >
                <Label>Agregar producto</Label>
                <ComboBox.InputGroup>
                  <Input placeholder="Alias o nombre" />
                  <ComboBox.Trigger />
                </ComboBox.InputGroup>
                <ComboBox.Popover>
                  <ListBox>
                    {agregables.map((f) => (
                      <ListBox.Item
                        key={f.productoId}
                        id={f.productoId}
                        textValue={f.nombreCanonico}
                      >
                        {f.nombreCanonico}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </ComboBox.Popover>
              </ComboBox>
              <Button
                className="w-full sm:w-auto"
                isDisabled={!agregarId}
                size="sm"
                variant="secondary"
                onPress={() => agregarProducto(agregarId)}
              >
                <Plus size={14} aria-hidden />
                Agregar
              </Button>
            </div>
          ) : null}
          <div className="flex flex-col gap-3 bg-[var(--ink-50)] px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            {editable && dirty ? (
              <Button
                className="w-full sm:w-auto"
                isPending={guardar.isPending}
                size="sm"
                variant="primary"
                onPress={() => guardar.mutate()}
              >
                {({ isPending }) => (
                  <>
                    {isPending && <Spinner color="current" size="sm" />}
                    Guardar cambios
                  </>
                )}
              </Button>
            ) : (
              <span />
            )}
            <span className="flex min-w-0 items-baseline justify-between gap-3 sm:ml-auto sm:justify-end">
              <span className="mst-label shrink-0">Total del pedido</span>
              <Money centavos={total} truncate className="text-lg" />
            </span>
          </div>
        </Card.Content>
      </Card>

      {pedido.estado === "ENTREGADO" ? (
        <Card className="p-5">
          <Card.Header className="p-0 pb-3">
            <Card.Title className="text-base text-tinta-900">Factura</Card.Title>
            <Card.Description>
              Número del DTE del sistema externo. Se captura después de entregar.
            </Card.Description>
          </Card.Header>
          <Card.Content className="flex min-w-0 flex-col flex-wrap items-stretch gap-2 p-0 sm:flex-row sm:items-center">
            {pedido.factura ? (
              <>
                <BotonDte
                  hint={hintDte}
                  numeroDte={pedido.factura.numeroDte}
                  puedeEditar={puedeDte}
                  presentacion={pedido.factura.numeroDte ? "inline" : "pill"}
                  onPress={() => setDteAbierto(true)}
                />
                <EstadoBadge estado={pedido.factura.estado} size="sm" />
                <Money
                  centavos={pedido.factura.saldoCentavos}
                  truncate
                  tone={
                    pedido.factura.estado === "VENCIDO"
                      ? "vencido"
                      : pedido.factura.estado === "ABONO_PARCIAL"
                        ? "pendiente"
                        : pedido.factura.estado === "PAGADO"
                          ? "pagado"
                          : "default"
                  }
                />
                <Link
                  className="text-sm sm:ml-auto"
                  href={`/cartera?clienteId=${pedido.clienteId}`}
                >
                  Ver en cartera
                </Link>
                {pedido.factura.pagos.length > 0 ? (
                  <ul className="grid w-full basis-full gap-3 border-t border-[var(--border-subtle)] pt-3">
                    {pedido.factura.pagos.map((p) => (
                      <li key={p.id} className="grid gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium text-tinta-900">
                            {PAGO_METODO_ETIQUETA[p.metodo]}
                          </span>
                          <span className="text-tinta-500">{p.fecha}</span>
                          <Money
                            centavos={p.montoCentavos}
                            truncate
                            className="sm:ml-auto"
                          />
                        </div>
                        {p.comprobanteAssetId ? (
                          <ComprobanteAssetPreview
                            assetId={p.comprobanteAssetId}
                            alt={`Comprobante ${PAGO_METODO_ETIQUETA[p.metodo].toLowerCase()} del ${p.fecha}`}
                            className="max-w-xs"
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-tinta-500">
                Este pedido está entregado pero no tiene factura registrada.
              </p>
            )}
          </Card.Content>
        </Card>
      ) : pedido.estado !== "ANULADO" ? (
        <p className="px-1 text-xs text-tinta-500">
          El DTE se captura cuando el pedido esté entregado.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <Card.Header className="p-0 pb-3">
            <Card.Title className="text-base text-tinta-900">
              Notas del administrador
            </Card.Title>
            <Card.Description>
              Libres, del día. El grosor y el horario salen del catálogo.
            </Card.Description>
          </Card.Header>
          <Card.Content className="p-0">
            <TextField
              aria-label="Notas del administrador"
              isDisabled={!editable}
              value={notas}
              onChange={(v) => {
                userEditedRef.current = true;
                setNotas(v);
              }}
            >
              <TextArea
                rows={3}
                placeholder="Ej. llevar junto con las tortillas de la mañana"
              />
            </TextField>
          </Card.Content>
        </Card>

        <Card className="p-5">
          <Card.Header className="p-0 pb-3">
            <Card.Title className="text-base text-tinta-900">Historial</Card.Title>
            <Card.Description>Quién hizo qué</Card.Description>
          </Card.Header>
          <Card.Content className="p-0">
            <ol className="grid gap-2 text-xs text-tinta-800">
              {pedido.historial.length === 0 ? (
                <li className="text-tinta-500">Sin movimientos todavía.</li>
              ) : (
                pedido.historial.map((h, i) => (
                  <li
                    key={`${h.accion}-${h.createdAt}-${i}`}
                    className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3"
                  >
                    <span className="shrink-0 font-mono tabular-nums text-tinta-500">
                      {horaEnZona(new Date(h.createdAt))}
                    </span>
                    <span className="min-w-0 text-pretty">
                      {h.actorNombre ?? h.actorTipo}{" "}
                      {ACCION_TEXTO[h.accion] ?? h.accion}
                    </span>
                  </li>
                ))
              )}
            </ol>
          </Card.Content>
        </Card>
      </div>

      {error && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No se guardó</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <Modal.Backdrop
        isOpen={anular}
        onOpenChange={(abierto) => !abierto && setAnular(false)}
      >
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>
                Anular el pedido #{pedido.correlativo}
              </Modal.Heading>
              <p className="text-sm text-tinta-500">
                El pedido no se borra: queda anulado con motivo y sigue visible en
                el historial.
              </p>
            </Modal.Header>
            <Modal.Body>
              <form
                id={`anular-${pedido.id}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (motivo.trim()) anularPedido.mutate();
                }}
              >
                <TextField isRequired value={motivo} onChange={setMotivo}>
                  <Label>Motivo</Label>
                  <TextArea rows={2} />
                  <Description>
                    Obligatorio. Queda registrado con tu usuario.
                  </Description>
                </TextField>
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onPress={() => setAnular(false)}>
                Cancelar
              </Button>
              <Button
                form={`anular-${pedido.id}`}
                isDisabled={!motivo.trim() || anularPedido.isPending}
                isPending={anularPedido.isPending}
                type="submit"
                variant="danger"
              >
                {({ isPending }) => (
                  <>
                    {isPending && <Spinner color="current" size="sm" />}
                    Anular pedido
                  </>
                )}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {ajustePrecios ? (
        <DialogoAjustePrecios
          pedido={pedido}
          onClose={() => setAjustePrecios(false)}
        />
      ) : null}

      {dteAbierto && pedido.factura ? (
        <DialogoCapturaDte
          clienteNombre={pedido.clienteNombre}
          correlativo={pedido.correlativo}
          facturaId={pedido.factura.id}
          hintDte={hintDte}
          loading={dte.isPending}
          numeroDte={pedido.factura.numeroDte}
          puedeDte={puedeDte}
          onClose={() => setDteAbierto(false)}
          onSave={(numeroDte) =>
            dte.mutate({ id: pedido.factura!.id, numeroDte })
          }
        />
      ) : null}
    </div>
  );
}

function mapItems(pedido: PedidoDetalleDto): ItemLocal[] {
  return pedido.items.map((item) => ({
    productoId: item.productoId,
    cantidad: item.cantidad,
    nombreMostrado: item.nombreMostrado,
    nombreCanonico: item.nombreCanonico,
    unidadMedida: item.unidadMedida,
    precioUnitarioCentavos: item.precioUnitarioCentavos,
    puntoCarga: item.puntoCarga,
    notaProduccion: item.notaProduccion,
    esDevolucion: item.esDevolucion,
    bonoId: item.bonoId,
  }));
}

function claveItemLocal(item: ItemLocal): string {
  return `${item.productoId}:${item.esDevolucion ? "1" : "0"}`;
}

function mismoItemsLocal(a: ItemLocal[], b: ItemLocal[]): boolean {
  if (a.length !== b.length) return false;
  const porClave = new Map(b.map((i) => [claveItemLocal(i), i]));
  return a.every((row) => {
    const other = porClave.get(claveItemLocal(row));
    return other != null && other.cantidad === row.cantidad;
  });
}
