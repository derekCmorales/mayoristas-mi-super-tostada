"use client";

import {
  Alert,
  Button,
  Description,
  Disclosure,
  Label,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import { useState } from "react";
import {
  textoEstadoCuenta,
  type ConversacionDetalle,
  type PlantillaWaPublica,
} from "@misupertostada/shared";
import { Send } from "lucide-react";
import {
  copyVentanaWhatsapp,
  propositoConectado,
} from "@/lib/conversacion-vista";
import { MensajePreview } from "@/components/domain/mensaje-preview";

export function ComposerWhatsapp({
  conversacion,
  plantillas,
  puedeEnviar,
  enviando,
  recordando,
  onEnviarTexto,
  onMandarEstadoCuenta,
  modoDesarrollo,
  onSimularInbound,
}: {
  conversacion: ConversacionDetalle;
  plantillas: PlantillaWaPublica[];
  puedeEnviar: boolean;
  enviando: boolean;
  recordando: boolean;
  onEnviarTexto: (cuerpo: string) => void;
  onMandarEstadoCuenta: () => void;
  modoDesarrollo?: boolean;
  onSimularInbound?: (cuerpo: string) => void;
}) {
  const [cuerpo, setCuerpo] = useState("");
  const [simular, setSimular] = useState("");

  const estadoCuentaConectado = propositoConectado(
    plantillas,
    "ESTADO_CUENTA",
  );
  const previewEstadoCuenta = textoEstadoCuenta({
    pendientes: conversacion.facturasPendientes,
    saldoCentavos: conversacion.saldoCentavos,
  });

  if (!puedeEnviar) {
    return (
      <p className="text-sm text-tinta-500">
        Puede leer el hilo. Enviar WhatsApp es de administración.
      </p>
    );
  }

  const pruebas =
    modoDesarrollo && onSimularInbound ? (
      <Disclosure>
        <Disclosure.Heading>
          <Button slot="trigger" size="sm" variant="tertiary">
            Pruebas
            <Disclosure.Indicator />
          </Button>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="grid gap-2 pt-2">
            <TextField value={simular} onChange={setSimular}>
              <Label>Simular mensaje del restaurante</Label>
              <TextArea rows={2} />
              <Description>
                Solo en desarrollo. Abre la ventana para responder en texto.
              </Description>
            </TextField>
            <Button
              className="justify-self-start"
              isDisabled={!simular.trim() || !conversacion.telefonoWa}
              size="sm"
              variant="secondary"
              onPress={() => onSimularInbound(simular)}
            >
              Simular mensaje del restaurante
            </Button>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    ) : null;

  if (conversacion.ventanaAbierta) {
    return (
      <div className="grid gap-3">
        <TextField value={cuerpo} onChange={setCuerpo}>
          <Label>Respuesta</Label>
          <TextArea rows={3} placeholder="Escriba la respuesta…" />
          <Description>
            El restaurante escribió recientemente. Puede contestar en texto
            libre.
          </Description>
        </TextField>

        {cuerpo.trim() ? (
          <MensajePreview
            variant="respuesta"
            cuerpo={cuerpo}
            hora="ahora"
            alineacion="derecha"
          />
        ) : null}

        <Button
          className="justify-self-start"
          isDisabled={!cuerpo.trim()}
          isPending={enviando}
          size="sm"
          variant="primary"
          onPress={() => onEnviarTexto(cuerpo)}
        >
          {({ isPending }) => (
            <>
              {isPending ? (
                <Spinner color="current" size="sm" />
              ) : (
                <Send size={15} aria-hidden />
              )}
              Enviar
            </>
          )}
        </Button>

        {pruebas}
      </div>
    );
  }

  const copyCerrada = copyVentanaWhatsapp({
    ventanaAbierta: false,
    restanteMs: null,
  });

  return (
    <div className="grid gap-3">
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{copyCerrada.titulo}</Alert.Title>
          <Alert.Description>{copyCerrada.descripcion}</Alert.Description>
        </Alert.Content>
      </Alert>

      <div className="grid gap-2">
        <Button
          className="justify-self-start"
          isDisabled={!estadoCuentaConectado || !conversacion.telefonoWa}
          isPending={recordando}
          size="sm"
          variant="primary"
          onPress={onMandarEstadoCuenta}
        >
          {({ isPending }) => (
            <>
              {isPending && <Spinner color="current" size="sm" />}
              Mandar estado de cuenta
            </>
          )}
        </Button>
        {!estadoCuentaConectado ? (
          <p className="text-xs text-tinta-500">
            Este aviso aún no está conectado.
          </p>
        ) : null}

        {estadoCuentaConectado ? (
          <MensajePreview
            variant="aviso"
            proposito="ESTADO_CUENTA"
            cuerpo={previewEstadoCuenta}
            hora="ahora"
            alineacion="derecha"
          />
        ) : null}
      </div>

      {pruebas}
    </div>
  );
}