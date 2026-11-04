/**
 * Genera `src/assets/marca.ts` con el logo y Nunito Sans en base64.
 *
 * Van incrustados y no como archivos porque la API se empaqueta con webpack:
 * una ruta relativa al módulo deja de existir en el bundle. Correr de nuevo si
 * cambia el logo (`apps/web/public/logo.png`) o la fuente del panel.
 *
 *   bun packages/pdf/scripts/embed-assets.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const fuentes = join(root, "apps/web/node_modules/@fontsource/nunito-sans/files");

// 240 px bastan para 56 pt impresos; el PNG original de 500 px infla cada envío.
const tmp = mkdtempSync(join(tmpdir(), "logo-"));
const logo = join(tmp, "logo.png");
execFileSync("sips", ["-Z", "240", join(root, "apps/web/public/logo.png"), "--out", logo], {
  stdio: "ignore",
});

const b64 = (p: string) => readFileSync(p).toString("base64");
const peso = (w: number) => b64(join(fuentes, `nunito-sans-latin-${w}-normal.woff2`));

writeFileSync(
  join(root, "packages/pdf/src/assets/marca.ts"),
  `// Generado por packages/pdf/scripts/embed-assets.ts. No editar a mano.
export const LOGO_PNG_BASE64 = "${b64(logo)}";
export const NUNITO_400_WOFF2_BASE64 = "${peso(400)}";
export const NUNITO_700_WOFF2_BASE64 = "${peso(700)}";
export const NUNITO_800_WOFF2_BASE64 = "${peso(800)}";
`,
);
console.log("packages/pdf/src/assets/marca.ts");
