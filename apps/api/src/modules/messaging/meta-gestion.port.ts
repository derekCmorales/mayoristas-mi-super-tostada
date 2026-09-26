export const META_GESTION_PORT = Symbol("META_GESTION_PORT");

/**
 * Las plantillas del WABA del negocio en Meta: alta, edición, retiro y estado.
 * Puerto aparte de `WhatsAppPort` (ISP): el dispatcher que envía mensajes no
 * tiene por qué conocer el ciclo de revisión de Meta.
 */

export type CredencialesWaba = { wabaId: string; accessToken: string };

export type PlantillaRemota = {
  metaTemplateId: string | null;
  name: string;
  language: string;
  status: string;
  category: string;
  componentes: unknown;
  motivoRechazo: string | null;
  calidad: string | null;
};

export interface MetaGestionPort {
  listarPlantillas(cred: CredencialesWaba): Promise<PlantillaRemota[]>;
  crearPlantilla(
    cred: CredencialesWaba & {
      name: string;
      language: string;
      category: string;
      componentes: unknown[];
    },
  ): Promise<{ metaTemplateId: string; status: string; category: string }>;
  editarPlantilla(input: {
    accessToken: string;
    metaTemplateId: string;
    componentes: unknown[];
  }): Promise<void>;
  retirarPlantilla(
    cred: CredencialesWaba & { name: string; metaTemplateId: string | null },
  ): Promise<void>;
  /** Subida reanudable del PDF de ejemplo para encabezados de documento. */
  subirEjemplo(input: {
    accessToken: string;
    bytes: Buffer;
    mime: string;
    filename: string;
  }): Promise<{ handle: string }>;
}
