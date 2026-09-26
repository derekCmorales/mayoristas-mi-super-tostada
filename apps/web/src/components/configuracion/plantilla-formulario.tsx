"use client";

import {
  Alert,
  Button,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { Braces, ExternalLink, Plus, Reply, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  META_CATEGORIA_ETIQUETA,
  PLANTILLA_BODY_MAX,
  PLANTILLA_BOTON_MAX,
  PLANTILLA_CATEGORIAS_CREABLES,
  PLANTILLA_FOOTER_MAX,
  PLANTILLA_HEADER_MAX,
  PLANTILLA_IDIOMAS,
  plantillaBorradorSchema,
  variablesDe,
  type PlantillaBorrador,
  type PlantillaBoton,
  type PlantillaMeta,
} from "@misupertostada/shared";
import { api } from "@/lib/api";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PlantillaVistaWhatsApp } from "./plantilla-vista-whatsapp";

export const IDIOMA_ETIQUETA: Record<string, string> = {
  es: "Español",
  es_MX: "Español (México)",
  es_ES: "Español (España)",
  en_US: "Inglés (EE. UU.)",
};

const CATEGORIA_AYUDA: Record<string, string> = {
  UTILITY: "Avisos de pedidos, entregas y cobros. Es lo que usa el sistema.",
  MARKETING: "Promociones y novedades. Meta la cobra varias veces más cara.",
};

const HEADER_OPCIONES = [
  { id: "NONE", label: "Sin encabezado" },
  { id: "TEXT", label: "Texto" },
  { id: "DOCUMENT", label: "Documento PDF" },
] as const;

export type ModoFormulario =
  | { tipo: "nueva" }
  | { tipo: "editar"; plantilla: PlantillaMeta; borrador: PlantillaBorrador }
  | { tipo: "duplicar"; borrador: PlantillaBorrador };

export function borradorVacio(): PlantillaBorrador {
  return {
    name: "",
    language: "es",
    category: "UTILITY",
    headerTipo: "NONE",
    headerTexto: undefined,
    headerEjemplos: [],
    body: "",
    bodyEjemplos: [],
    footer: undefined,
    botones: [],
  };
}

/** Deja tantos ejemplos como variables distintas haya, conservando lo escrito. */
function ajustarEjemplos(texto: string, previos: string[]): string[] {
  const n = new Set(variablesDe(texto)).size;
  return Array.from({ length: n }, (_, i) => previos[i] ?? "");
}

/** Normaliza lo que se envía: campos de encabezado solo si aplican, pie vacío fuera. */
function limpiar(b: PlantillaBorrador): PlantillaBorrador {
  return {
    ...b,
    headerTexto: b.headerTipo === "TEXT" ? b.headerTexto : undefined,
    headerEjemplos: b.headerTipo === "TEXT" ? b.headerEjemplos : [],
    footer: b.footer?.trim() ? b.footer : undefined,
  };
}

export function PlantillaFormulario({
  modo,
  onClose,
  onGuardada,
}: {
  modo: ModoFormulario;
  onClose: () => void;
  onGuardada: (p: PlantillaMeta) => void;
}) {
  const editando = modo.tipo === "editar";
  const [b, setB] = useState<PlantillaBorrador>(() =>
    modo.tipo === "nueva" ? borradorVacio() : modo.borrador,
  );
  const [intentado, setIntentado] = useState(false);
  const cuerpoRef = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<PlantillaBorrador>) => setB((prev) => ({ ...prev, ...patch }));

  const enviable = limpiar(b);
  const validacion = plantillaBorradorSchema.safeParse(enviable);

  /* Errores por campo. Se muestran cuando el campo ya tiene algo o tras el
     primer intento: nadie quiere ver el formulario en rojo al abrirlo. */
  const errores = useMemo(() => {
    const map = new Map<string, string>();
    if (validacion.success) return map;
    for (const issue of validacion.error.issues) {
      const clave = issue.path.map(String).join(".");
      if (!map.has(clave)) map.set(clave, issue.message);
    }
    return map;
  }, [validacion]);
  const error = (clave: string, tieneValor: boolean) =>
    intentado || tieneValor ? errores.get(clave) : undefined;

  const guardar = useMutation<PlantillaMeta, Error, void>({
    mutationFn: () =>
      editando
        ? api<PlantillaMeta>(`/mensajeria/meta/plantillas/${modo.plantilla.id}`, {
            method: "PUT",
            body: JSON.stringify(enviable),
          })
        : api<PlantillaMeta>("/mensajeria/meta/plantillas", {
            method: "POST",
            body: JSON.stringify(enviable),
          }),
    onSuccess: (p) => {
      toastSuccess(
        p.status === "APPROVED"
          ? "Plantilla aprobada y lista para usar"
          : "Enviada a Meta. Le avisamos aquí cuando la revisen.",
      );
      onGuardada(p);
    },
    onError: toastFromError,
  });

  function enviar() {
    setIntentado(true);
    if (validacion.success) guardar.mutate();
  }

  /** Inserta la siguiente variable donde está el cursor del cuerpo. */
  function insertarVariable() {
    const n = new Set(variablesDe(b.body)).size + 1;
    const token = `{{${n}}}`;
    const area = cuerpoRef.current?.querySelector("textarea");
    const inicio = area?.selectionStart ?? b.body.length;
    const fin = area?.selectionEnd ?? b.body.length;
    const body = `${b.body.slice(0, inicio)}${token}${b.body.slice(fin)}`;
    set({ body, bodyEjemplos: ajustarEjemplos(body, b.bodyEjemplos) });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(inicio + token.length, inicio + token.length);
    });
  }

  function setBoton(i: number, patch: Partial<PlantillaBoton>) {
    set({
      botones: b.botones.map((btn, j) =>
        j === i ? ({ ...btn, ...patch } as PlantillaBoton) : btn,
      ),
    });
  }

  const titulo =
    modo.tipo === "editar"
      ? "Editar plantilla"
      : modo.tipo === "duplicar"
        ? "Nueva versión"
        : "Nueva plantilla";

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal.Container size="cover" scroll="inside">
        <Modal.Dialog className="max-w-5xl">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{titulo}</Modal.Heading>
            <p className="max-w-[64ch] text-sm text-tinta-500 text-pretty">
              {editando
                ? "Toda edición vuelve a revisión de Meta. En plantillas aprobadas Meta permite una edición al día y diez al mes."
                : "Se envía a Meta para revisión. Suele tardar minutos y puede tardar hasta 24 horas."}
            </p>
          </Modal.Header>

          <Modal.Body>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid content-start gap-6">
                <Seccion titulo="Identidad" nota={editando ? "Meta fija estos datos al crear." : undefined}>
                  <TextField
                    isRequired
                    isDisabled={editando}
                    isInvalid={Boolean(error("name", Boolean(b.name)))}
                    value={b.name}
                    onChange={(v) => set({ name: v.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") })}
                  >
                    <Label>Nombre en Meta</Label>
                    <Input className="font-mono" placeholder="mst_recordatorio_cobro_v1" />
                    {error("name", Boolean(b.name)) ? (
                      <FieldError>{error("name", Boolean(b.name))}</FieldError>
                    ) : (
                      <Description>
                        Minúsculas, números y guion bajo. Terminar en _v1 ayuda a sacar versiones nuevas.
                      </Description>
                    )}
                  </TextField>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Select
                      isDisabled={editando}
                      value={b.category}
                      onChange={(v) => typeof v === "string" && set({ category: v as PlantillaBorrador["category"] })}
                    >
                      <Label>Categoría</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Description>{CATEGORIA_AYUDA[b.category]}</Description>
                      <Select.Popover>
                        <ListBox>
                          {PLANTILLA_CATEGORIAS_CREABLES.map((c) => (
                            <ListBox.Item key={c} id={c} textValue={META_CATEGORIA_ETIQUETA[c]}>
                              {META_CATEGORIA_ETIQUETA[c]}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    <Select
                      isDisabled={editando}
                      value={b.language}
                      onChange={(v) => typeof v === "string" && set({ language: v as PlantillaBorrador["language"] })}
                    >
                      <Label>Idioma</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {PLANTILLA_IDIOMAS.map((l) => (
                            <ListBox.Item key={l} id={l} textValue={IDIOMA_ETIQUETA[l]}>
                              {IDIOMA_ETIQUETA[l]}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  </div>
                </Seccion>

                <Seccion titulo="Encabezado">
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tipo de encabezado">
                    {HEADER_OPCIONES.map((o) => {
                      const activo = b.headerTipo === o.id;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="radio"
                          aria-checked={activo}
                          onClick={() => set({ headerTipo: o.id })}
                          className={cn(
                            "min-h-10 rounded-pill border px-4 text-sm font-semibold transition-colors duration-control",
                            "focus-visible:outline-none focus-visible:shadow-foco",
                            activo
                              ? "border-marca bg-marca-soft text-marca"
                              : "border-[var(--border-subtle)] text-tinta-800 hover:bg-[var(--ink-50)]",
                          )}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                  {b.headerTipo === "DOCUMENT" ? (
                    <p className="text-xs leading-relaxed text-tinta-500 text-pretty">
                      Al enviar, el sistema adjunta el PDF (por ejemplo, el estado de
                      cuenta). Para la revisión mandamos a Meta un PDF de muestra; no
                      tiene que subir nada.
                    </p>
                  ) : null}
                  {b.headerTipo === "TEXT" ? (
                    <>
                      <TextField
                        isInvalid={Boolean(error("headerTexto", Boolean(b.headerTexto)))}
                        value={b.headerTexto ?? ""}
                        onChange={(v) => set({ headerTexto: v, headerEjemplos: ajustarEjemplos(v, b.headerEjemplos) })}
                      >
                        <Label>Texto del encabezado</Label>
                        <Input maxLength={PLANTILLA_HEADER_MAX} placeholder="Pedido {{1}}" />
                        {error("headerTexto", Boolean(b.headerTexto)) ? (
                          <FieldError>{error("headerTexto", Boolean(b.headerTexto))}</FieldError>
                        ) : (
                          <Description>
                            {(b.headerTexto ?? "").length}/{PLANTILLA_HEADER_MAX} · una variable como máximo
                          </Description>
                        )}
                      </TextField>
                      <Ejemplos
                        prefijo="Encabezado"
                        valores={b.headerEjemplos}
                        error={error("headerEjemplos", false)}
                        onChange={(headerEjemplos) => set({ headerEjemplos })}
                      />
                    </>
                  ) : null}
                </Seccion>

                <Seccion
                  titulo="Mensaje"
                  accion={
                    <Button size="sm" variant="secondary" onPress={insertarVariable}>
                      <Braces size={14} aria-hidden />
                      Insertar variable
                    </Button>
                  }
                >
                  <div ref={cuerpoRef}>
                    <TextField
                      isRequired
                      isInvalid={Boolean(error("body", Boolean(b.body)))}
                      value={b.body}
                      onChange={(v) => set({ body: v, bodyEjemplos: ajustarEjemplos(v, b.bodyEjemplos) })}
                    >
                      <Label>Cuerpo</Label>
                      <TextArea
                        rows={6}
                        maxLength={PLANTILLA_BODY_MAX}
                        placeholder="Buenas noches. Su pedido {{1}} para el {{2}} quedó confirmado. Gracias por su compra."
                      />
                      {error("body", Boolean(b.body)) ? (
                        <FieldError>{error("body", Boolean(b.body))}</FieldError>
                      ) : (
                        <Description>
                          {b.body.length}/{PLANTILLA_BODY_MAX} · lo variable va como {"{{1}}"}, {"{{2}}"}… y no
                          puede abrir ni cerrar el mensaje.
                        </Description>
                      )}
                    </TextField>
                  </div>
                  <Ejemplos
                    prefijo="Variable"
                    valores={b.bodyEjemplos}
                    error={error("bodyEjemplos", false)}
                    onChange={(bodyEjemplos) => set({ bodyEjemplos })}
                  />
                  <TextField
                    isInvalid={Boolean(error("footer", Boolean(b.footer)))}
                    value={b.footer ?? ""}
                    onChange={(v) => set({ footer: v })}
                  >
                    <Label>Pie (opcional)</Label>
                    <Input maxLength={PLANTILLA_FOOTER_MAX} placeholder="Mi Súper Tostada" />
                    {error("footer", Boolean(b.footer)) ? (
                      <FieldError>{error("footer", Boolean(b.footer))}</FieldError>
                    ) : (
                      <Description>Texto fijo en gris, sin variables.</Description>
                    )}
                  </TextField>
                </Seccion>

                <Seccion titulo="Botones" nota="Opcional, hasta tres.">
                  {b.botones.length ? (
                    <ul className="grid gap-3">
                      {b.botones.map((btn, i) => (
                        <li
                          key={i}
                          className="grid gap-3 rounded-campo border border-[var(--border-subtle)] p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="flex items-center gap-1.5 text-xs font-semibold text-tinta-800">
                              {btn.tipo === "URL" ? (
                                <ExternalLink size={14} aria-hidden />
                              ) : (
                                <Reply size={14} aria-hidden />
                              )}
                              {btn.tipo === "URL" ? "Enlace" : "Respuesta rápida"}
                            </p>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="tertiary"
                              aria-label="Quitar botón"
                              onPress={() => set({ botones: b.botones.filter((_, j) => j !== i) })}
                            >
                              <X size={14} aria-hidden />
                            </Button>
                          </div>
                          <div className={cn("grid gap-3", btn.tipo === "URL" && "sm:grid-cols-[12rem_1fr]")}>
                            <TextField value={btn.texto} onChange={(texto) => setBoton(i, { texto })}>
                              <Label>Texto</Label>
                              <Input maxLength={PLANTILLA_BOTON_MAX} placeholder={btn.tipo === "URL" ? "Ver mi pedido" : "Ya pagué"} />
                            </TextField>
                            {btn.tipo === "URL" ? (
                              <TextField
                                isInvalid={Boolean(error(`botones.${i}.url`, Boolean(btn.url)))}
                                value={btn.url}
                                onChange={(url) => setBoton(i, { url })}
                              >
                                <Label>Enlace</Label>
                                <Input placeholder="https://pedidos.misupertostada.com/p/{{1}}" />
                                {error(`botones.${i}.url`, Boolean(btn.url)) ? (
                                  <FieldError>{error(`botones.${i}.url`, Boolean(btn.url))}</FieldError>
                                ) : (
                                  <Description>Termine en {"{{1}}"} para un enlace distinto por cliente.</Description>
                                )}
                              </TextField>
                            ) : null}
                          </div>
                          {btn.tipo === "URL" && variablesDe(btn.url).length ? (
                            <TextField
                              isInvalid={Boolean(error(`botones.${i}.ejemplo`, Boolean(btn.ejemplo)))}
                              value={btn.ejemplo ?? ""}
                              onChange={(ejemplo) => setBoton(i, { ejemplo })}
                            >
                              <Label>Enlace de ejemplo completo</Label>
                              <Input placeholder="https://pedidos.misupertostada.com/p/abc123" />
                              {error(`botones.${i}.ejemplo`, Boolean(btn.ejemplo)) ? (
                                <FieldError>{error(`botones.${i}.ejemplo`, Boolean(btn.ejemplo))}</FieldError>
                              ) : null}
                            </TextField>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {errores.get("botones") && intentado ? (
                    <p className="text-xs text-peligro">{errores.get("botones")}</p>
                  ) : null}
                  {b.botones.length < 3 ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => set({ botones: [...b.botones, { tipo: "QUICK_REPLY", texto: "" }] })}
                      >
                        <Plus size={14} aria-hidden />
                        Respuesta rápida
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => set({ botones: [...b.botones, { tipo: "URL", texto: "", url: "" }] })}
                      >
                        <Plus size={14} aria-hidden />
                        Enlace
                      </Button>
                    </div>
                  ) : null}
                </Seccion>
              </div>

              <aside className="grid content-start gap-3 lg:sticky lg:top-0">
                <p className="mst-label">Así llegará</p>
                <PlantillaVistaWhatsApp borrador={b} />
                <p className="text-xs leading-relaxed text-tinta-500 text-pretty">
                  Meta revisa con los ejemplos: use datos creíbles (un restaurante,
                  un monto, una fecha). En verde lo que llenará el sistema; en
                  amarillo, variables sin ejemplo.
                </p>
              </aside>
            </div>
          </Modal.Body>

          <Modal.Footer className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div aria-live="polite" className="min-h-5">
              {intentado && !validacion.success ? (
                <Alert status="danger" className="py-2">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>
                      {errores.size === 1 ? "Falta corregir 1 dato." : `Faltan corregir ${errores.size} datos.`}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" onPress={onClose}>
                Cancelar
              </Button>
              <Button variant="primary" isDisabled={guardar.isPending} onPress={enviar}>
                {guardar.isPending
                  ? "Enviando a Meta…"
                  : editando
                    ? "Guardar y enviar a revisión"
                    : "Enviar a revisión"}
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function Seccion({
  titulo,
  nota,
  accion,
  children,
}: {
  titulo: string;
  nota?: string;
  accion?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t border-[var(--border-subtle)] pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-tinta-900">{titulo}</h3>
          {nota ? <p className="text-xs text-tinta-500">{nota}</p> : null}
        </div>
        {accion}
      </div>
      {children}
    </section>
  );
}

function Ejemplos({
  prefijo,
  valores,
  error,
  onChange,
}: {
  prefijo: string;
  valores: string[];
  error?: string;
  onChange: (v: string[]) => void;
}) {
  if (valores.length === 0) return null;
  return (
    <div className="grid gap-2 rounded-campo bg-[var(--ink-50)] p-3">
      <p className="text-xs font-semibold text-tinta-800">Ejemplos para la revisión de Meta</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {valores.map((v, i) => (
          <TextField
            key={i}
            isRequired
            value={v}
            onChange={(nuevo) => onChange(valores.map((x, j) => (j === i ? nuevo : x)))}
          >
            <Label>
              {prefijo} <span className="font-mono">{`{{${i + 1}}}`}</span>
            </Label>
            <Input placeholder={i === 0 ? "Tabascos" : "Q 250.00"} />
          </TextField>
        ))}
      </div>
      {error ? <p className="text-xs text-peligro">{error}</p> : null}
    </div>
  );
}
