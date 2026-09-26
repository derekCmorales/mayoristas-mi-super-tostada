import { z } from "zod";

/**
 * Plantillas de Meta: alta, edición, retiro y estado de revisión de las
 * plantillas del WABA del negocio, vía Graph API con el token del Embedded
 * Signup. El sistema las usa para los avisos automáticos (ver `messaging.ts`).
 */

export const META_CATEGORIA_ETIQUETA: Record<string, string> = {
  MARKETING: "Marketing",
  UTILITY: "Utilidad",
  AUTHENTICATION: "Autenticación",
};

/** `rejected_reason` de Meta → qué corregir, dicho para quien lo va a arreglar. */
export const META_MOTIVO_RECHAZO_ETIQUETA: Record<string, string> = {
  INVALID_FORMAT:
    "Formato inválido: revise variables seguidas, saltos de línea o ejemplos que no coinciden.",
  TAG_CONTENT_MISMATCH:
    "La categoría no coincide con el contenido. Un aviso de pedido o cobro es Utilidad; una promoción es Marketing.",
  INCORRECT_CATEGORY:
    "Categoría incorrecta. Meta la reclasificó o la rechazó por el contenido.",
  PROMOTIONAL:
    "Meta la considera promocional. Quite ofertas o llamados a comprar, o créela como Marketing.",
  ABUSIVE_CONTENT: "Meta detectó contenido que viola sus políticas.",
  SCAM: "Meta la marcó como posible engaño. Revise enlaces y el tono del mensaje.",
};

export function motivoRechazoLegible(motivo: string): string {
  return META_MOTIVO_RECHAZO_ETIQUETA[motivo] ?? motivo;
}

/* ─── Plantillas ─────────────────────────────────────────────────────── */

export const PLANTILLA_CATEGORIAS_CREABLES = ["UTILITY", "MARKETING"] as const;
export const PLANTILLA_IDIOMAS = ["es", "es_MX", "es_ES", "en_US"] as const;
export const PLANTILLA_HEADER_TIPOS = ["NONE", "TEXT", "DOCUMENT"] as const;

export const META_PLANTILLA_STATUS_ETIQUETA: Record<string, string> = {
  APPROVED: "Aprobada",
  PENDING: "En revisión",
  IN_APPEAL: "En apelación",
  REJECTED: "Rechazada",
  PAUSED: "Pausada",
  DISABLED: "Desactivada",
  LIMIT_EXCEEDED: "Límite excedido",
  PENDING_DELETION: "Por retirar",
  DELETED: "Retirada de Meta",
  FLAGGED: "Marcada",
  REINSTATED: "Restablecida",
};

export const PLANTILLA_BODY_MAX = 1024;
export const PLANTILLA_HEADER_MAX = 60;
export const PLANTILLA_FOOTER_MAX = 60;
export const PLANTILLA_BOTON_MAX = 25;

/** Índices `{{n}}` en orden de aparición. */
export function variablesDe(texto: string): number[] {
  return [...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

const botonSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("QUICK_REPLY"),
    texto: z.string().trim().min(1).max(PLANTILLA_BOTON_MAX),
  }),
  z.object({
    tipo: z.literal("URL"),
    texto: z.string().trim().min(1).max(PLANTILLA_BOTON_MAX),
    /** Puede terminar en `{{1}}` para un sufijo dinámico (p. ej. el token del portal). */
    url: z.string().trim().url().max(2000),
    ejemplo: z.string().trim().max(2000).optional(),
  }),
]);
export type PlantillaBoton = z.infer<typeof botonSchema>;

function revisarVariables(
  texto: string,
  ejemplos: readonly string[],
  campo: string,
  ctx: z.RefinementCtx,
): void {
  const vars = variablesDe(texto);
  const unicas = [...new Set(vars)].sort((a, b) => a - b);
  if (unicas.some((n, i) => n !== i + 1)) {
    ctx.addIssue({
      code: "custom",
      path: [campo],
      message: "Las variables van en orden: {{1}}, {{2}}, {{3}}…",
    });
  }
  if (ejemplos.length !== unicas.length) {
    ctx.addIssue({
      code: "custom",
      path: [`${campo}Ejemplos`],
      message: `Meta exige un ejemplo por variable (${unicas.length}).`,
    });
  }
  if (ejemplos.some((e) => e.trim().length === 0)) {
    ctx.addIssue({
      code: "custom",
      path: [`${campo}Ejemplos`],
      message: "Ningún ejemplo puede ir vacío.",
    });
  }
}

export const plantillaBorradorSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[a-z0-9_]+$/, "Solo minúsculas, números y guion bajo"),
    language: z.enum(PLANTILLA_IDIOMAS),
    category: z.enum(PLANTILLA_CATEGORIAS_CREABLES),
    headerTipo: z.enum(PLANTILLA_HEADER_TIPOS),
    headerTexto: z.string().trim().max(PLANTILLA_HEADER_MAX).optional(),
    headerEjemplos: z.array(z.string().max(200)).max(1),
    body: z.string().trim().min(1).max(PLANTILLA_BODY_MAX),
    bodyEjemplos: z.array(z.string().max(200)).max(20),
    footer: z.string().trim().max(PLANTILLA_FOOTER_MAX).optional(),
    botones: z.array(botonSchema).max(3),
  })
  .superRefine((v, ctx) => {
    revisarVariables(v.body, v.bodyEjemplos, "body", ctx);
    if (/^\s*\{\{/.test(v.body) || /\}\}\s*$/.test(v.body)) {
      ctx.addIssue({
        code: "custom",
        path: ["body"],
        message: "Meta rechaza cuerpos que empiezan o terminan con una variable.",
      });
    }
    if (v.headerTipo === "TEXT") {
      if (!v.headerTexto) {
        ctx.addIssue({
          code: "custom",
          path: ["headerTexto"],
          message: "Escriba el encabezado o quítelo.",
        });
      } else {
        if (variablesDe(v.headerTexto).length > 1) {
          ctx.addIssue({
            code: "custom",
            path: ["headerTexto"],
            message: "El encabezado admite una sola variable.",
          });
        }
        revisarVariables(v.headerTexto, v.headerEjemplos, "header", ctx);
      }
    }
    if (v.footer && variablesDe(v.footer).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["footer"],
        message: "El pie no admite variables.",
      });
    }
    const urls = v.botones.filter((b) => b.tipo === "URL");
    const replies = v.botones.filter((b) => b.tipo === "QUICK_REPLY");
    if (urls.length > 2) {
      ctx.addIssue({
        code: "custom",
        path: ["botones"],
        message: "Máximo dos botones de enlace.",
      });
    }
    const cambiosDeTipo = v.botones.filter(
      (b, i) => i > 0 && b.tipo !== v.botones[i - 1]!.tipo,
    ).length;
    if (urls.length && replies.length && cambiosDeTipo > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["botones"],
        message: "Agrupe las respuestas rápidas antes que los enlaces.",
      });
    }
    for (const [i, b] of v.botones.entries()) {
      if (b.tipo !== "URL") continue;
      const vars = variablesDe(b.url);
      if (vars.length > 1 || (vars.length === 1 && !/\{\{1\}\}$/.test(b.url))) {
        ctx.addIssue({
          code: "custom",
          path: ["botones", i, "url"],
          message: "Solo una variable, {{1}}, al final del enlace.",
        });
      }
      if (vars.length === 1 && !b.ejemplo) {
        ctx.addIssue({
          code: "custom",
          path: ["botones", i, "ejemplo"],
          message: "Meta exige un enlace de ejemplo completo.",
        });
      }
    }
  });
export type PlantillaBorrador = z.infer<typeof plantillaBorradorSchema>;

/**
 * Borrador → `components` del Graph API (`POST /{waba}/message_templates`).
 * `headerHandle` es el handle de subida reanudable del PDF de ejemplo; solo
 * aplica a encabezados de documento.
 */
export function componentesMetaDeBorrador(
  b: PlantillaBorrador,
  headerHandle?: string,
): unknown[] {
  const out: unknown[] = [];
  if (b.headerTipo === "TEXT" && b.headerTexto) {
    out.push({
      type: "HEADER",
      format: "TEXT",
      text: b.headerTexto,
      ...(b.headerEjemplos.length
        ? { example: { header_text: b.headerEjemplos } }
        : {}),
    });
  }
  if (b.headerTipo === "DOCUMENT") {
    out.push({
      type: "HEADER",
      format: "DOCUMENT",
      ...(headerHandle ? { example: { header_handle: [headerHandle] } } : {}),
    });
  }
  out.push({
    type: "BODY",
    text: b.body,
    ...(b.bodyEjemplos.length
      ? { example: { body_text: [b.bodyEjemplos] } }
      : {}),
  });
  if (b.footer) out.push({ type: "FOOTER", text: b.footer });
  if (b.botones.length) {
    out.push({
      type: "BUTTONS",
      buttons: b.botones.map((btn) =>
        btn.tipo === "QUICK_REPLY"
          ? { type: "QUICK_REPLY", text: btn.texto }
          : {
              type: "URL",
              text: btn.texto,
              url: btn.url,
              ...(btn.ejemplo ? { example: [btn.ejemplo] } : {}),
            },
      ),
    });
  }
  return out;
}

/** Inverso tolerante: `components` de Meta → borrador editable del formulario. */
export function borradorDeComponentes(input: {
  name: string;
  language: string;
  category: string;
  componentes?: unknown;
}): PlantillaBorrador {
  const comps = Array.isArray(input.componentes)
    ? (input.componentes as Array<Record<string, unknown>>)
    : [];
  const tipo = (c: Record<string, unknown>) => String(c.type ?? "").toUpperCase();
  const header = comps.find((c) => tipo(c) === "HEADER");
  const body = comps.find((c) => tipo(c) === "BODY");
  const footer = comps.find((c) => tipo(c) === "FOOTER");
  const buttons = comps.find((c) => tipo(c) === "BUTTONS");
  const ejemplo = (c: Record<string, unknown> | undefined, key: string) => {
    const ex = c?.example as Record<string, unknown> | undefined;
    const raw = ex?.[key];
    if (!Array.isArray(raw)) return [];
    const plano = Array.isArray(raw[0]) ? raw[0] : raw;
    return (plano as unknown[]).map(String);
  };
  const formato = String(header?.format ?? "").toUpperCase();
  const idioma = (PLANTILLA_IDIOMAS as readonly string[]).includes(input.language)
    ? (input.language as PlantillaBorrador["language"])
    : "es";
  const categoria = input.category === "MARKETING" ? "MARKETING" : "UTILITY";
  return {
    name: input.name,
    language: idioma,
    category: categoria,
    headerTipo: formato === "TEXT" ? "TEXT" : formato === "DOCUMENT" ? "DOCUMENT" : "NONE",
    headerTexto: formato === "TEXT" ? String(header?.text ?? "") : undefined,
    headerEjemplos: formato === "TEXT" ? ejemplo(header, "header_text") : [],
    body: String(body?.text ?? ""),
    bodyEjemplos: ejemplo(body, "body_text"),
    footer: footer ? String(footer.text ?? "") : undefined,
    botones: (Array.isArray(buttons?.buttons) ? (buttons.buttons as Array<Record<string, unknown>>) : [])
      .flatMap((btn): PlantillaBoton[] => {
        const t = String(btn.type ?? "").toUpperCase();
        if (t === "QUICK_REPLY") return [{ tipo: "QUICK_REPLY", texto: String(btn.text ?? "") }];
        if (t === "URL") {
          const ex = Array.isArray(btn.example) ? String(btn.example[0] ?? "") : undefined;
          return [
            {
              tipo: "URL",
              texto: String(btn.text ?? ""),
              url: String(btn.url ?? ""),
              ...(ex ? { ejemplo: ex } : {}),
            },
          ];
        }
        return [];
      }),
  };
}

export const plantillaMetaSchema = z.object({
  id: z.string().uuid(),
  metaTemplateId: z.string().nullable(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  motivoRechazo: z.string().nullable(),
  calidad: z.string().nullable(),
  componentes: z.unknown(),
  /** Aviso automático que usa esta plantilla; retirarla lo rompería. */
  proposito: z.string().nullable(),
  sincronizadoAt: z.string().nullable(),
});
export type PlantillaMeta = z.infer<typeof plantillaMetaSchema>;

export const retirarPlantillaRequestSchema = z.object({
  motivo: z.string().trim().min(3).max(500),
});
