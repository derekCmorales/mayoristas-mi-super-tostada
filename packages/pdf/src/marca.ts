import type { FontLoader, ImagesInput } from "takumi-pdf";
import {
  LOGO_PNG_BASE64,
  NUNITO_400_WOFF2_BASE64,
  NUNITO_700_WOFF2_BASE64,
  NUNITO_800_WOFF2_BASE64,
} from "./assets/marca";

/**
 * Identidad del panel llevada al PDF: los mismos tokens que
 * `apps/web/src/styles/tokens/colors.css` y la misma Nunito Sans.
 * Los documentos que recibe el cliente se tienen que ver como el portal.
 */
export const TOKENS = {
  green900: "#062E0A",
  green800: "#0E4E15",
  green700: "#136220",
  green200: "#C2E7C7",
  green100: "#DFF2E1",
  green50: "#F1F8F1",
  yellow400: "#FFE100",
  yellow100: "#FFF9D6",
  cream300: "#F6F1E4",
  cream100: "#FBF8F0",
  ink900: "#17190F",
  ink800: "#282A20",
  ink600: "#575B4C",
  ink500: "#767A69",
  ink200: "#DEDFD6",
  ink100: "#EDEEE8",
  ink50: "#F7F7F4",
  white: "#FFFFFF",
  red700: "#8E1C16",
  red100: "#FBE4E2",
  amber700: "#8A5502",
  amber100: "#FDF0D6",
  blue700: "#154A63",
  blue100: "#E1EFF5",
} as const;

export const FUENTE = "Nunito Sans";
/** `src` con el que el árbol pide el logo; los bytes van en `images`. */
export const LOGO_SRC = "mst-logo.png";

const bytes = (b64: string) => Buffer.from(b64, "base64");

export const FUENTES_MARCA: FontLoader[] = [
  { name: FUENTE, weight: 400, data: () => bytes(NUNITO_400_WOFF2_BASE64) },
  { name: FUENTE, weight: 700, data: () => bytes(NUNITO_700_WOFF2_BASE64) },
  { name: FUENTE, weight: 800, data: () => bytes(NUNITO_800_WOFF2_BASE64) },
];

export const IMAGENES_MARCA: ImagesInput = [
  { src: LOGO_SRC, data: bytes(LOGO_PNG_BASE64) },
];
