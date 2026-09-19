import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { conexionWaba } from "@misupertostada/db";
import { DomainException } from "../shared/domain.exception";
import type { AppDatabase } from "../shared/database.module";
import type {
  GraphPlantilla,
  SendTemplateInput,
  WhatsAppPort,
  WhatsAppSendResult,
} from "./whatsapp.port";

export function verificarFirmaMeta(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type AuthWaba = {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
};

export type ResolverAuthWaba = (
  organizacionId: string,
) => Promise<AuthWaba | null>;

/**
 * El adapter Graph no lee `conexion_waba` a ciegas desde el dominio:
 * el composition root le pasa este lookup. Los tests inyectan un stub.
 */
export function resolverAuthWabaDesdeDb(
  db: AppDatabase,
  crypto: { decrypt(payload: string): string | null },
): ResolverAuthWaba {
  return async (organizacionId) => {
    const [row] = await db
      .select()
      .from(conexionWaba)
      .where(eq(conexionWaba.organizacionId, organizacionId))
      .limit(1);
    if (!row?.phoneNumberId || !row.accessTokenCifrado || !row.wabaId) {
      return null;
    }
    const accessToken = crypto.decrypt(row.accessTokenCifrado);
    if (!accessToken) return null;
    return {
      accessToken,
      phoneNumberId: row.phoneNumberId,
      wabaId: row.wabaId,
    };
  };
}

export class GraphWhatsAppAdapter implements WhatsAppPort {
  constructor(
    private readonly graphVersion: string,
    private readonly resolverAuth: ResolverAuthWaba,
  ) {}

  async sendText(input: {
    organizacionId: string;
    to: string;
    body: string;
  }): Promise<WhatsAppSendResult> {
    const auth = await this.requireAuth(input.organizacionId);
    const json = await graphPost(
      this.graphVersion,
      `${auth.phoneNumberId}/messages`,
      auth.accessToken,
      {
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: { body: input.body },
      },
    );
    return { waMessageId: String(json.messages?.[0]?.id ?? "") };
  }

  async sendTemplate(input: SendTemplateInput): Promise<WhatsAppSendResult> {
    const auth = await this.requireAuth(input.organizacionId);
    const components: unknown[] = [];
    if (input.headerDocumentId) {
      components.push({
        type: "header",
        parameters: [
          { type: "document", document: { id: input.headerDocumentId } },
        ],
      });
    }
    if (input.bodyParams.length) {
      components.push({
        type: "body",
        parameters: input.bodyParams.map((text) => ({ type: "text", text })),
      });
    }
    if (input.buttonParams?.length) {
      components.push({
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: input.buttonParams.map((text) => ({ type: "text", text })),
      });
    }
    const json = await graphPost(
      this.graphVersion,
      `${auth.phoneNumberId}/messages`,
      auth.accessToken,
      {
        messaging_product: "whatsapp",
        to: input.to,
        type: "template",
        template: {
          name: input.name,
          language: { code: input.language },
          components,
        },
      },
    );
    return { waMessageId: String(json.messages?.[0]?.id ?? "") };
  }

  async uploadDocument(input: {
    organizacionId: string;
    bytes: Buffer;
    mime: string;
    filename: string;
  }): Promise<{ mediaId: string }> {
    const auth = await this.requireAuth(input.organizacionId);
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", input.mime);
    form.set(
      "file",
      new Blob([new Uint8Array(input.bytes)], { type: input.mime }),
      input.filename,
    );
    const res = await fetch(
      `https://graph.facebook.com/${this.graphVersion}/${auth.phoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        body: form,
      },
    );
    const json = (await res.json()) as {
      id?: string;
      error?: { message?: string; code?: number };
    };
    if (!res.ok) {
      throw new DomainException(
        "WHATSAPP",
        json.error?.message ?? "No se pudo subir el documento a Meta",
        502,
      );
    }
    return { mediaId: String(json.id) };
  }

  async syncTemplates(input: {
    wabaId: string;
    accessToken: string;
  }): Promise<GraphPlantilla[]> {
    const url = `https://graph.facebook.com/${this.graphVersion}/${input.wabaId}/message_templates?limit=250`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    const json = (await res.json()) as {
      data?: Array<{
        name: string;
        language: string;
        status: string;
        category: string;
        components?: unknown;
      }>;
    };
    if (!res.ok) {
      throw new DomainException(
        "WHATSAPP",
        "No se pudieron sincronizar las plantillas",
        502,
      );
    }
    return (json.data ?? []).map((row) => ({
      name: row.name,
      language: row.language,
      status: row.status,
      category: row.category,
      componentes: row.components ?? [],
    }));
  }

  async subscribeWaba(input: {
    wabaId: string;
    accessToken: string;
  }): Promise<void> {
    await graphPost(
      this.graphVersion,
      `${input.wabaId}/subscribed_apps`,
      input.accessToken,
      {},
    );
  }

  private async requireAuth(organizacionId: string): Promise<AuthWaba> {
    const auth = await this.resolverAuth(organizacionId);
    if (!auth) {
      throw new DomainException(
        "NO_DISPONIBLE",
        "WhatsApp no está conectado",
        409,
      );
    }
    return auth;
  }
}

async function graphPost(
  version: string,
  path: string,
  token: string,
  body: unknown,
): Promise<{ messages?: Array<{ id: string }>; error?: { message?: string; code?: number } }> {
  const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    messages?: Array<{ id: string }>;
    error?: { message?: string; code?: number };
  };
  if (!res.ok) {
    const code = json.error?.code === 131047 ? "VENTANA_WA_CERRADA" : "WHATSAPP";
    throw new DomainException(
      code,
      json.error?.message ?? "Error de WhatsApp",
      code === "VENTANA_WA_CERRADA" ? 409 : 502,
    );
  }
  return json;
}
