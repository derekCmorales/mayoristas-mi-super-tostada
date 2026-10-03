"use client";

import {
  Alert,
  Button,
  Modal,
  Spinner,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  tienePermiso,
  totalPedidoCentavos,
  precioEfectivoCentavos,
  type ActorPublico,
  type CalendarioAhora,
  type ClienteBonoPublico,
  type ClienteProductoFila,
  type ClientePublico,
  type PedidoDetalle,
  type PortalCuenta,
  type ProductoPublico,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { agruparProductosCaptura } from "@/lib/pedido-vista";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { CapturaManualAviso } from "@/components/ordering/captura-manual-aviso";
import { CapturaManualBonos } from "@/components/ordering/captura-manual-bonos";
import { CapturaManualCatalogo } from "@/components/ordering/captura-manual-catalogo";
import { CapturaManualCliente } from "@/components/ordering/captura-manual-cliente";
import { CapturaManualPie } from "@/components/ordering/captura-manual-pie";

type PropsCaptura = {
  open: boolean;
  onClose: () => void;
  onCaptured: (pedido: PedidoDetalle) => void;
};

/**
 * El formulario solo se monta con el diálogo abierto: al cerrar se desmonta y
 * el estado se va con él. Antes se limpiaba con un efecto sobre `open`, que
 * además dejaba el formulario viejo visible un frame al reabrir.
 */
export function CapturaManual(props: PropsCaptura) {
  if (!props.open) return null;
  return <FormularioCaptura {...props} />;
}

function FormularioCaptura({ open, onClose, onCaptured }: PropsCaptura) {
  const [clienteId, setClienteId] = useState("");
  const [cantidades, setCantidades] = useState<Record<string, number>>({});
  const [cantidadesBono, setCantidadesBono] = useState<Record<string, number>>({});
  const [precios, setPrecios] = useState<Record<string, number | null>>({});
  const [guardarEnCliente, setGuardarEnCliente] = useState<Record<string, boolean>>({});
  const [notasAdmin, setNotasAdmin] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
    enabled: open,
  });
  const puedeFijarPrecio = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "precios.cambiar",
  );
  const clientes = useQuery({
    queryKey: ["clientes"],
    queryFn: () => api<ClientePublico[]>("/clientes"),
    enabled: open,
  });
  const calendario = useQuery({
    queryKey: ["calendario", "ahora"],
    queryFn: () => api<CalendarioAhora>("/calendario/ahora"),
    enabled: open,
  });
  const productos = useQuery({
    queryKey: ["clientes", clienteId, "productos"],
    queryFn: () => api<ClienteProductoFila[]>(`/clientes/${clienteId}/productos`),
    enabled: open && Boolean(clienteId),
  });
  const catalogo = useQuery({
    queryKey: ["productos"],
    queryFn: () => api<ProductoPublico[]>("/productos"),
    enabled: open,
  });
  const cuenta = useQuery({
    queryKey: ["clientes", clienteId, "cuenta"],
    queryFn: () => api<PortalCuenta>(`/clientes/${clienteId}/cuenta`),
    enabled: open && Boolean(clienteId),
  });
  const bonos = useQuery({
    queryKey: ["clientes", clienteId, "bonos"],
    queryFn: () => api<ClienteBonoPublico[]>(`/clientes/${clienteId}/bonos`),
    enabled: open && Boolean(clienteId),
  });

  const activos = useMemo(
    () => (clientes.data ?? []).filter((c) => c.activo),
    [clientes.data],
  );

  const fotoPorProducto = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const p of catalogo.data ?? []) map.set(p.id, p.fotoAssetId);
    return map;
  }, [catalogo.data]);

  const grupos = useMemo(() => {
    const list = productos.data ?? [];
    const needle = q.trim().toLowerCase();
    const filtrados = !needle
      ? list
      : list.filter(
          (p) =>
            p.nombreCanonico.toLowerCase().includes(needle) ||
            (p.alias ?? "").toLowerCase().includes(needle),
        );
    return agruparProductosCaptura(filtrados);
  }, [productos.data, q]);

  const filaDe = (productoId: string) =>
    productos.data?.find((p) => p.productoId === productoId);
  const precioCatalogo = (productoId: string) => {
    const fila = filaDe(productoId);
    return fila
      ? precioEfectivoCentavos({
          precioClienteCentavos: fila.precioCentavos,
          precioBaseCentavos: fila.precioBaseCentavos,
        })
      : null;
  };
  /** Lo que cobrará la línea: el puesto a mano si lo hay, si no el de catálogo. */
  const precioLinea = (productoId: string) =>
    puedeFijarPrecio && precios[productoId] !== undefined
      ? precios[productoId]
      : precioCatalogo(productoId);

  const itemsPagados = Object.entries(cantidades)
    .filter(([, cantidad]) => cantidad > 0)
    .map(([productoId, cantidad]) => {
      const precio = precioLinea(productoId);
      return {
        productoId,
        cantidad,
        esDevolucion: false,
        // El servidor valida el permiso; solo se manda si cambió.
        ...(precio != null && precio !== precioCatalogo(productoId)
          ? { precioUnitarioCentavos: precio }
          : {}),
      };
    });
  const sinPrecio = itemsPagados.filter(
    (item) => precioLinea(item.productoId) == null,
  ).length;
  const itemsBonos = Object.entries(cantidadesBono)
    .filter(([, cantidad]) => cantidad > 0)
    .flatMap(([bonoId, cantidad]) => {
      const bono = (bonos.data ?? []).find((b) => b.id === bonoId);
      if (!bono) return [];
      return [
        {
          productoId: bono.productoId,
          cantidad,
          esDevolucion: true as const,
          bonoId,
        },
      ];
    });
  const items = [...itemsPagados, ...itemsBonos];
  const total = totalPedidoCentavos(
    items.map((item) => {
      if (item.esDevolucion) {
        return { cantidad: item.cantidad, precioUnitarioCentavos: 0 };
      }
      return {
        cantidad: item.cantidad,
        precioUnitarioCentavos: precioLinea(item.productoId) ?? 0,
      };
    }),
  );
  const lineas = itemsPagados.length + itemsBonos.length;
  const bonosDisponibles = (bonos.data ?? []).filter(
    (b) => !b.anuladoAt && b.cantidadDisponible > 0,
  );

  const clienteSeleccionado = activos.find((c) => c.id === clienteId);
  const limiteExcedido =
    cuenta.data != null &&
    cuenta.data.limiteFacturasPendientes != null &&
    cuenta.data.facturasPendientes >= cuenta.data.limiteFacturasPendientes;

  const capturar = useMutation({
    mutationFn: () =>
      api<PedidoDetalle>("/pedidos", {
        method: "POST",
        body: JSON.stringify({
          clienteId,
          items,
          notasAdmin: notasAdmin.trim() || undefined,
        }),
      }),
    onSuccess: async (pedido) => {
      toastSuccess(`Pedido #${pedido.correlativo} capturado`);
      await guardarPreciosDelCliente();
      onCaptured(pedido);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "No se pudo capturar");
      toastFromError(err, "No se pudo capturar");
    },
  });

  /**
   * «Guardar como precio de este cliente»: el pedido ya salió con su precio;
   * esto además lo deja en el catálogo del cliente para los siguientes. Si
   * falla, el pedido sigue capturado y se avisa.
   */
  async function guardarPreciosDelCliente() {
    const aGuardar = itemsPagados.flatMap((item) => {
      const precio = precioLinea(item.productoId);
      if (!guardarEnCliente[item.productoId] || precio == null) return [];
      if (precio === precioCatalogo(item.productoId)) return [];
      return [{ productoId: item.productoId, precio }];
    });
    if (aGuardar.length === 0) return;
    try {
      for (const { productoId, precio } of aGuardar) {
        await api(`/clientes/${clienteId}/productos/${productoId}`, {
          method: "PUT",
          body: JSON.stringify({ precioCentavos: precio }),
        });
      }
      toastSuccess(
        aGuardar.length === 1
          ? "Precio guardado para el cliente"
          : `${aGuardar.length} precios guardados para el cliente`,
      );
    } catch (err) {
      toastFromError(
        err,
        "El pedido se capturó, pero no se guardó el precio del cliente",
      );
    } finally {
      await qc.invalidateQueries({ queryKey: ["clientes", clienteId] });
    }
  }

  function cambiarPrecio(productoId: string, centavos: number | null) {
    setPrecios((prev) => ({ ...prev, [productoId]: centavos }));
  }

  function cambiarGuardarEnCliente(productoId: string, guardar: boolean) {
    setGuardarEnCliente((prev) => ({ ...prev, [productoId]: guardar }));
  }

  function seleccionarCliente(id: string) {
    setClienteId(id);
    setCantidades({});
    setCantidadesBono({});
    setPrecios({});
    setGuardarEnCliente({});
    setNotasAdmin("");
    setQ("");
    setError(null);
  }

  function cambiarCantidadBono(bonoId: string, cantidad: number) {
    setCantidadesBono((prev) => {
      const next = { ...prev };
      if (cantidad <= 0) delete next[bonoId];
      else next[bonoId] = cantidad;
      return next;
    });
  }

  function cambiarCantidadProducto(productoId: string, cantidad: number) {
    setCantidades((prev) => {
      const next = { ...prev };
      if (cantidad <= 0) delete next[productoId];
      else next[productoId] = cantidad;
      return next;
    });
  }

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(abierto) => !abierto && onClose()}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Capturar pedido</Modal.Heading>
            <p className="text-sm text-tinta-500">
              Pedido por llamada. Salta la ventana. Queda en CONFIRMADO con su
              correlativo.
            </p>
          </Modal.Header>

          <Modal.Body>
            <div className="grid gap-4">
              {calendario.data ? (
                <CapturaManualAviso calendario={calendario.data} />
              ) : null}

              <CapturaManualCliente
                clientes={activos}
                clienteId={clienteId}
                onClienteChange={seleccionarCliente}
                cuenta={cuenta.data}
                limiteExcedido={limiteExcedido}
                clienteNombre={clienteSeleccionado?.nombre}
              />

              {clienteId && bonosDisponibles.length > 0 ? (
                <CapturaManualBonos
                  bonos={bonosDisponibles}
                  cantidadesBono={cantidadesBono}
                  onCantidadChange={cambiarCantidadBono}
                />
              ) : null}

              {clienteId ? (
                <>
                  <CapturaManualCatalogo
                    grupos={grupos}
                    cargando={productos.isLoading}
                    q={q}
                    onBusquedaChange={setQ}
                    fotoPorProducto={fotoPorProducto}
                    cantidades={cantidades}
                    onCantidadChange={cambiarCantidadProducto}
                    puedeFijarPrecio={puedeFijarPrecio}
                    precios={precios}
                    onPrecioChange={cambiarPrecio}
                    guardarEnCliente={guardarEnCliente}
                    onGuardarEnClienteChange={cambiarGuardarEnCliente}
                  />

                  <CapturaManualPie
                    notasAdmin={notasAdmin}
                    onNotasChange={setNotasAdmin}
                    totalCentavos={total}
                    lineas={lineas}
                    itemsBonos={itemsBonos.length}
                  />
                </>
              ) : null}

              {sinPrecio > 0 && (
                <p className="text-sm text-aviso-700">
                  {sinPrecio === 1
                    ? "Una línea no tiene precio. Póngale uno para capturar."
                    : `${sinPrecio} líneas no tienen precio. Póngales uno para capturar.`}
                </p>
              )}

              {error && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>No se capturó</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
            </div>
          </Modal.Body>

          <Modal.Footer className="flex-wrap gap-2">
            <Button variant="tertiary" onPress={onClose}>
              Cancelar
            </Button>
            <Button
              className="button--accent w-full sm:w-auto"
              isDisabled={
                !clienteId ||
                items.length === 0 ||
                sinPrecio > 0 ||
                capturar.isPending
              }
              isPending={capturar.isPending}
              variant="primary"
              onPress={() => capturar.mutate()}
            >
              {({ isPending }) => (
                <>
                  {isPending && <Spinner color="current" size="sm" />}
                  Capturar pedido
                </>
              )}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
