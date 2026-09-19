import { config } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

config({ path: resolve(process.cwd(), "../../.env") });
config({ path: resolve(process.cwd(), ".env") });

/** Compose inyecta "" cuando la variable no está; Zod la trata como ausente. */
const optionalText = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.string().url().optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatorio"),
    API_PORT: z.coerce.number().int().positive().default(3001),
    WEB_ORIGIN: z.string().url("WEB_ORIGIN debe ser una URL absoluta"),
    SESSION_COOKIE_NAME: z.string().min(1).default("session"),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
    R2_ACCOUNT_ID: optionalText,
    R2_ACCESS_KEY_ID: optionalText,
    R2_SECRET_ACCESS_KEY: optionalText,
    R2_BUCKET: optionalText,
    R2_ENDPOINT: optionalUrl,
    R2_PUBLIC_BASE_URL: optionalUrl,
    APP_ENCRYPTION_KEY: z.preprocess(
      (v) => (v === "" || v === undefined ? undefined : v),
      z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, "APP_ENCRYPTION_KEY debe ser 32 bytes hex")
        .optional(),
    ),
    META_APP_ID: optionalText,
    META_APP_SECRET: optionalText,
    META_CONFIG_ID: optionalText,
    META_VERIFY_TOKEN: optionalText,
    META_GRAPH_VERSION: z.preprocess(
      (v) => (v === "" || v === undefined ? undefined : v),
      z.string().min(1).default("v21.0"),
    ),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== "production") return;
    const required = [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_ENDPOINT",
      "APP_ENCRYPTION_KEY",
    ] as const;
    for (const key of required) {
      if (!data[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} es obligatorio en production`,
          path: [key],
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function metaSignupConfigured(env: Env): boolean {
  return Boolean(env.META_APP_ID && env.META_CONFIG_ID);
}

/** Hay app de Meta: el composition root elige Graph en vez del fake. */
export function metaWhatsAppConfigured(env: Pick<Env, "META_APP_ID">): boolean {
  return Boolean(env.META_APP_ID);
}

export function r2Configured(env: Env): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET &&
      env.R2_ENDPOINT,
  );
}

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuración incompleta: ${issues}`);
  }
  return parsed.data;
}
