import { metaWhatsAppConfigured, type Env } from "../../config/env";
import type { WhatsAppPort } from "./whatsapp.port";

/**
 * Único sitio que nombra el concreto de WhatsApp según config.
 * El dispatcher y las conversaciones solo ven `WhatsAppPort`.
 */
export function elegirPuertoWhatsApp(
  env: Pick<Env, "META_APP_ID">,
  fake: WhatsAppPort,
  graph: WhatsAppPort,
): WhatsAppPort {
  return metaWhatsAppConfigured(env) ? graph : fake;
}
