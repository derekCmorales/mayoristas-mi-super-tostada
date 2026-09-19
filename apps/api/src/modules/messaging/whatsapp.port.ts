export const WHATSAPP_PORT = Symbol("WHATSAPP_PORT");

export type WhatsAppSendResult = { waMessageId: string };

export type GraphPlantilla = {
  name: string;
  language: string;
  status: string;
  category: string;
  componentes: unknown;
};

export type SendTemplateInput = {
  organizacionId: string;
  to: string;
  name: string;
  language: string;
  bodyParams: string[];
  buttonParams?: string[];
  headerDocumentId?: string;
};

export interface WhatsAppPort {
  sendText(input: {
    organizacionId: string;
    to: string;
    body: string;
  }): Promise<WhatsAppSendResult>;
  sendTemplate(input: SendTemplateInput): Promise<WhatsAppSendResult>;
  uploadDocument(input: {
    organizacionId: string;
    bytes: Buffer;
    mime: string;
    filename: string;
  }): Promise<{ mediaId: string }>;
  syncTemplates(input: {
    wabaId: string;
    accessToken: string;
  }): Promise<GraphPlantilla[]>;
  subscribeWaba(input: {
    wabaId: string;
    accessToken: string;
  }): Promise<void>;
}
