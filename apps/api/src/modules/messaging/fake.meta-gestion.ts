import { Injectable } from "@nestjs/common";
import type {
  MetaGestionPort,
  PlantillaRemota,
} from "./meta-gestion.port";

/** Meta simulado. `plantillas` la fija quien lo use (tests); aquí no se inventa nada. */
@Injectable()
export class FakeMetaGestionAdapter implements MetaGestionPort {
  plantillas: PlantillaRemota[] = [];
  readonly creadas: Array<{ name: string; componentes: unknown[] }> = [];
  readonly editadas: Array<{ metaTemplateId: string; componentes: unknown[] }> = [];
  readonly retiradas: Array<{ name: string; metaTemplateId: string | null }> = [];
  /** Próxima respuesta de revisión al crear. Desarrollo aprueba al instante. */
  statusAlCrear = "APPROVED";

  reset(): void {
    this.plantillas = [];
    this.creadas.length = 0;
    this.editadas.length = 0;
    this.retiradas.length = 0;
    this.statusAlCrear = "APPROVED";
  }

  async listarPlantillas(): Promise<PlantillaRemota[]> {
    return this.plantillas;
  }

  async crearPlantilla(input: {
    name: string;
    language: string;
    category: string;
    componentes: unknown[];
  }): Promise<{ metaTemplateId: string; status: string; category: string }> {
    this.creadas.push({ name: input.name, componentes: input.componentes });
    return {
      metaTemplateId: `hsm.fake.${crypto.randomUUID()}`,
      status: this.statusAlCrear,
      category: input.category,
    };
  }

  async editarPlantilla(input: {
    metaTemplateId: string;
    componentes: unknown[];
  }): Promise<void> {
    this.editadas.push(input);
  }

  async retirarPlantilla(input: {
    name: string;
    metaTemplateId: string | null;
  }): Promise<void> {
    this.retiradas.push({ name: input.name, metaTemplateId: input.metaTemplateId });
  }

  async subirEjemplo(): Promise<{ handle: string }> {
    return { handle: `handle.fake.${crypto.randomUUID()}` };
  }
}
