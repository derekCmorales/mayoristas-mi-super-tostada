import { describe, expect, test } from "bun:test";
import { loadEnv, metaWhatsAppConfigured } from "./env";

describe("loadEnv", () => {
  test("cadenas vacías de compose no cuentan como valor", () => {
    const snapshot = { ...process.env };
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/t";
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.R2_ACCOUNT_ID = "";
    process.env.META_APP_ID = "";
    process.env.APP_ENCRYPTION_KEY = "";
    try {
      const env = loadEnv();
      expect(env.R2_ACCOUNT_ID).toBeUndefined();
      expect(env.META_APP_ID).toBeUndefined();
      expect(env.APP_ENCRYPTION_KEY).toBeUndefined();
      expect(env.META_GRAPH_VERSION).toBe("v21.0");
      expect(metaWhatsAppConfigured(env)).toBe(false);
      expect(metaWhatsAppConfigured({ META_APP_ID: "123" })).toBe(true);
    } finally {
      for (const key of Object.keys(process.env)) {
        delete process.env[key];
      }
      Object.assign(process.env, snapshot);
    }
  });
});
