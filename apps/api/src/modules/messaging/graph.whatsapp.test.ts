import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GraphWhatsAppAdapter,
  verificarFirmaMeta,
} from "./graph.whatsapp";

describe("verificarFirmaMeta", () => {
  test("acepta HMAC-SHA256 de X-Hub-Signature-256 y rechaza body adulterado", () => {
    const secret = "app-secret";
    const raw = Buffer.from(`{"object":"whatsapp_business_account"}`, "utf8");
    const header = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verificarFirmaMeta(raw, header, secret)).toBe(true);
    expect(verificarFirmaMeta(Buffer.from("nope"), header, secret)).toBe(false);
    expect(verificarFirmaMeta(raw, "sha256=deadbeef", secret)).toBe(false);
  });
});

describe("GraphWhatsAppAdapter", () => {
  const orgId = "org-1";
  const auth = {
    accessToken: "tok-waba",
    phoneNumberId: "phone-99",
    wabaId: "waba-1",
  };

  test("no importa loadEnv: la versión y el auth los inyecta el composition root", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "graph.whatsapp.ts"),
      "utf8",
    );
    expect(src).not.toContain("loadEnv");
    expect(src).not.toContain("bind(");
  });

  test("sin credenciales de la org lanza NO_DISPONIBLE", async () => {
    const wa = new GraphWhatsAppAdapter("v21.0", async () => null);
    await expect(
      wa.sendText({ organizacionId: orgId, to: "50240000000", body: "hola" }),
    ).rejects.toMatchObject({
      code: "NO_DISPONIBLE",
      httpStatus: 409,
    });
  });

  test("con auth POST a Graph usando la versión inyectada, no process.env", async () => {
    const wa = new GraphWhatsAppAdapter("v21.0", async (id) =>
      id === orgId ? auth : null,
    );
    const original = globalThis.fetch;
    const llamadas: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      llamadas.push(url);
      expect(url).toBe(
        "https://graph.facebook.com/v21.0/phone-99/messages",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok-waba");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.graph.1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const sent = await wa.sendText({
        organizacionId: orgId,
        to: "50240000000",
        body: "hola",
      });
      expect(sent.waMessageId).toBe("wamid.graph.1");
      expect(llamadas).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
