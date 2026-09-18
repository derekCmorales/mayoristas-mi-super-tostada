import { Injectable } from "@nestjs/common";
import type {
  GraphPlantilla,
  SendTemplateInput,
  WhatsAppPort,
  WhatsAppSendResult,
} from "./whatsapp.port";

export type FakeEnvio = {
  kind: "text" | "template";
  to: string;
  body?: string;
  name?: string;
  language?: string;
  bodyParams?: string[];
  buttonParams?: string[];
  headerDocumentId?: string;
  waMessageId: string;
};

@Injectable()
export class FakeWhatsAppAdapter implements WhatsAppPort {
  readonly envios: FakeEnvio[] = [];
  readonly uploads: { mediaId: string; filename: string }[] = [];
  plantillas: GraphPlantilla[] = [];

  reset(): void {
    this.envios.length = 0;
    this.uploads.length = 0;
  }

  async sendText(input: {
    organizacionId: string;
    to: string;
    body: string;
  }): Promise<WhatsAppSendResult> {
    const waMessageId = `wamid.fake.${crypto.randomUUID()}`;
    this.envios.push({
      kind: "text",
      to: input.to,
      body: input.body,
      waMessageId,
    });
    return { waMessageId };
  }

  async sendTemplate(input: SendTemplateInput): Promise<WhatsAppSendResult> {
    const waMessageId = `wamid.fake.${crypto.randomUUID()}`;
    this.envios.push({
      kind: "template",
      to: input.to,
      name: input.name,
      language: input.language,
      bodyParams: input.bodyParams,
      buttonParams: input.buttonParams,
      headerDocumentId: input.headerDocumentId,
      waMessageId,
    });
    return { waMessageId };
  }

  async uploadDocument(input: {
    organizacionId: string;
    bytes: Buffer;
    mime: string;
    filename: string;
  }): Promise<{ mediaId: string }> {
    const mediaId = `media.fake.${crypto.randomUUID()}`;
    this.uploads.push({ mediaId, filename: input.filename });
    return { mediaId };
  }

  async syncTemplates(): Promise<GraphPlantilla[]> {
    return this.plantillas;
  }

  async subscribeWaba(): Promise<void> {
    /* Fake: ya “conectado” en modo desarrollo. */
  }
}
