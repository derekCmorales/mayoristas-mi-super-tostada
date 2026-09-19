"use client";

import { Alert, ComboBox, Input, Label, ListBox } from "@heroui/react";
import type { ClientePublico, PortalCuenta } from "@misupertostada/shared";
import { ContadorFacturas } from "@/components/domain/contador-facturas";

export function CapturaManualCliente({
  clientes,
  clienteId,
  onClienteChange,
  cuenta,
  limiteExcedido,
  clienteNombre,
}: {
  clientes: ClientePublico[];
  clienteId: string;
  onClienteChange: (id: string) => void;
  cuenta: PortalCuenta | undefined;
  limiteExcedido: boolean;
  clienteNombre: string | undefined;
}) {
  return (
    <>
      <ComboBox
        isRequired
        selectedKey={clienteId || null}
        onSelectionChange={(key) => {
          onClienteChange(typeof key === "string" ? key : "");
        }}
      >
        <Label>Cliente</Label>
        <ComboBox.InputGroup>
          <Input placeholder="Buscar restaurante" />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <ComboBox.Popover>
          <ListBox>
            {clientes.map((c) => (
              <ListBox.Item key={c.id} id={c.id} textValue={c.nombre}>
                {c.nombre}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>

      {clienteId && cuenta ? (
        <ContadorFacturas
          pendientes={cuenta.facturasPendientes}
          limite={cuenta.limiteFacturasPendientes}
          montoCentavos={cuenta.saldoCentavos}
          etiqueta={
            clienteNombre
              ? `Facturas · ${clienteNombre}`
              : "Facturas pendientes"
          }
        />
      ) : null}

      {limiteExcedido ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Límite de crédito excedido</Alert.Title>
            <Alert.Description>
              Puede capturar igual; avise a cartera.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </>
  );
}
