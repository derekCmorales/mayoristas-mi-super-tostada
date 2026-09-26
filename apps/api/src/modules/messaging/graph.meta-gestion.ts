import { DomainException } from "../shared/domain.exception";
import type {
  CredencialesWaba,
  MetaGestionPort,
  PlantillaRemota,
} from "./meta-gestion.port";

type GraphError = { error?: { message?: string; code?: number; error_user_msg?: string } };

const CAMPOS_PLANTILLA =
  "id,name,language,status,category,components,rejected_reason,quality_score";

/** Adapter real contra el Graph API de Meta. */
export class GraphMetaGestionAdapter implements MetaGestionPort {
  constructor(
    private readonly graphVersion: string,
    private readonly appId: string | undefined,
  ) {}

  private url(path: string): string {
    return `https://graph.facebook.com/${this.graphVersion}/${path}`;
  }

  async listarPlantillas(cred: CredencialesWaba): Promise<PlantillaRemota[]> {
    const out: PlantillaRemota[] = [];
    let next: string | undefined = this.url(
      `${cred.wabaId}/message_templates?fields=${CAMPOS_PLANTILLA}&limit=100`,
    );
    /* Meta pagina con `paging.next`. Tope de 20 páginas por si el cursor cicla. */
    for (let i = 0; next && i < 20; i++) {
      const json: {
        data?: Array<{
          id?: string;
          name: string;
          language: string;
          status: string;
          category: string;
          components?: unknown;
          rejected_reason?: string;
          quality_score?: { score?: string };
        }>;
        paging?: { next?: string };
      } = await graphGet(next, cred.accessToken, "No se pudieron leer las plantillas");
      for (const row of json.data ?? []) {
        out.push({
          metaTemplateId: row.id ?? null,
          name: row.name,
          language: row.language,
          status: row.status,
          category: row.category,
          componentes: row.components ?? [],
          motivoRechazo:
            row.rejected_reason && row.rejected_reason !== "NONE"
              ? row.rejected_reason
              : null,
          calidad: row.quality_score?.score ?? null,
        });
      }
      next = json.paging?.next;
    }
    return out;
  }

  async crearPlantilla(
    cred: CredencialesWaba & {
      name: string;
      language: string;
      category: string;
      componentes: unknown[];
    },
  ): Promise<{ metaTemplateId: string; status: string; category: string }> {
    const json = await graphSend<{ id?: string; status?: string; category?: string }>(
      "POST",
      this.url(`${cred.wabaId}/message_templates`),
      cred.accessToken,
      {
        name: cred.name,
        language: cred.language,
        category: cred.category,
        components: cred.componentes,
      },
      "Meta no aceptó la plantilla",
    );
    return {
      metaTemplateId: String(json.id ?? ""),
      status: json.status ?? "PENDING",
      category: json.category ?? cred.category,
    };
  }

  async editarPlantilla(input: {
    accessToken: string;
    metaTemplateId: string;
    componentes: unknown[];
  }): Promise<void> {
    await graphSend(
      "POST",
      this.url(input.metaTemplateId),
      input.accessToken,
      { components: input.componentes },
      "Meta no aceptó la edición",
    );
  }

  async retirarPlantilla(
    cred: CredencialesWaba & { name: string; metaTemplateId: string | null },
  ): Promise<void> {
    const qs = new URLSearchParams({ name: cred.name });
    /* Con `hsm_id` se retira solo ese idioma; sin él Meta borra todos. */
    if (cred.metaTemplateId) qs.set("hsm_id", cred.metaTemplateId);
    await graphSend(
      "DELETE",
      this.url(`${cred.wabaId}/message_templates?${qs.toString()}`),
      cred.accessToken,
      undefined,
      "Meta no retiró la plantilla",
    );
  }

  async subirEjemplo(input: {
    accessToken: string;
    bytes: Buffer;
    mime: string;
    filename: string;
  }): Promise<{ handle: string }> {
    if (!this.appId) {
      throw new DomainException("NO_DISPONIBLE", "Falta META_APP_ID para subir el ejemplo", 409);
    }
    const qs = new URLSearchParams({
      file_name: input.filename,
      file_length: String(input.bytes.length),
      file_type: input.mime,
    });
    const sesion = await graphSend<{ id?: string }>(
      "POST",
      this.url(`${this.appId}/uploads?${qs.toString()}`),
      input.accessToken,
      undefined,
      "Meta no abrió la subida del ejemplo",
    );
    const res = await fetch(this.url(String(sesion.id)), {
      method: "POST",
      headers: { Authorization: `OAuth ${input.accessToken}`, file_offset: "0" },
      body: new Uint8Array(input.bytes),
    });
    const json = (await res.json()) as { h?: string } & GraphError;
    if (!res.ok || !json.h) {
      throw errorGraph(json, "Meta no recibió el documento de ejemplo");
    }
    return { handle: json.h };
  }
}

function errorGraph(json: GraphError, fallback: string): DomainException {
  /* `error_user_msg` es el texto que Meta redacta para el usuario final
     (p. ej. "Ya existe una plantilla con ese nombre"); se prefiere al técnico. */
  const msg = json.error?.error_user_msg ?? json.error?.message ?? fallback;
  return new DomainException("WHATSAPP", msg, 502);
}

async function graphGet<T>(url: string, token: string, fallback: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as T & GraphError;
  if (!res.ok) throw errorGraph(json, fallback);
  return json;
}

async function graphSend<T>(
  method: "POST" | "DELETE",
  url: string,
  token: string,
  body: unknown,
  fallback: string,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & GraphError;
  if (!res.ok) throw errorGraph(json, fallback);
  return json;
}
