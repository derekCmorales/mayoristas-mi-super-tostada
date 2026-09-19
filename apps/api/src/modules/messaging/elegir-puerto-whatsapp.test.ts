import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { elegirPuertoWhatsApp } from "./elegir-puerto-whatsapp";
import { FakeWhatsAppAdapter } from "./fake.whatsapp";
import { GraphWhatsAppAdapter } from "./graph.whatsapp";
import type { WhatsAppPort } from "./whatsapp.port";

const graphStub: WhatsAppPort = new GraphWhatsAppAdapter("v21.0", async () => null);

describe("elegirPuertoWhatsApp", () => {
  test("sin META_APP_ID el root nombra el fake", () => {
    const fake = new FakeWhatsAppAdapter();
    const elegido = elegirPuertoWhatsApp({}, fake, graphStub);
    expect(elegido).toBe(fake);
  });

  test("con META_APP_ID el root nombra Graph, no el fake", () => {
    const fake = new FakeWhatsAppAdapter();
    const elegido = elegirPuertoWhatsApp(
      { META_APP_ID: "1234567890" },
      fake,
      graphStub,
    );
    expect(elegido).toBe(graphStub);
    expect(elegido).not.toBe(fake);
  });

  test("MessagingModule usa elegirPuertoWhatsApp y no hardcodea el fake", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "messaging.module.ts"),
      "utf8",
    );
    expect(src).toContain("elegirPuertoWhatsApp");
    expect(src).toContain("resolverAuthWabaDesdeDb");
    expect(src).not.toContain("useFactory: (fake: FakeWhatsAppAdapter) => fake");
  });
});
