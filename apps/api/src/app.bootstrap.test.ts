import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { postgresListo } from "./test/db";

const listo = await postgresListo();
const distMain = join(import.meta.dir, "..", "dist", "main.js");
const buildListo = existsSync(distMain);
const API_PORT = process.env.API_PORT ?? "3001";
const HEALTH_URL = `http://127.0.0.1:${API_PORT}/health`;

function esperarHealth(timeoutMs = 15_000): Promise<Response> {
  const inicio = Date.now();
  return new Promise((resolve, reject) => {
    const intentar = async () => {
      try {
        const res = await fetch(HEALTH_URL);
        if (res.ok) return resolve(res);
      } catch {
        /* servidor aún no escucha */
      }
      if (Date.now() - inicio > timeoutMs) {
        reject(new Error(`timeout esperando ${HEALTH_URL}`));
        return;
      }
      setTimeout(intentar, 200);
    };
    void intentar();
  });
}

describe.skipIf(!listo || !buildListo)("Nest boot smoke (Node /health)", () => {
  test("dist/main.js arranca y responde db ok", async () => {
    const proc = spawn("node", ["dist/main.js"], {
      cwd: import.meta.dir + "/..",
      env: { ...process.env, NODE_ENV: "test", API_PORT },
      stdio: "pipe",
    });

    try {
      const res = await esperarHealth();
      const body = (await res.json()) as {
        success: boolean;
        data?: { status: string; db: string };
      };
      expect(body.success).toBe(true);
      expect(body.data?.status).toBe("ok");
      expect(body.data?.db).toBe("ok");
    } finally {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3000);
      });
    }
  }, 20_000);
});
