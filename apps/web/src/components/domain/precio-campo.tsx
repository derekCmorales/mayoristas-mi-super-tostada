"use client";

import { Description, Input, Label, TextField } from "@heroui/react";
import { useState } from "react";
import {
  formatearCentavos,
  quetzalesTextoACentavos,
} from "@misupertostada/shared";
import { cn } from "@/lib/utils";

function texto(centavos: number | null): string {
  return centavos == null
    ? ""
    : formatearCentavos(centavos, { simbolo: false, miles: false });
}

function parsear(valor: string): number | null {
  try {
    return valor.trim() === "" ? null : quetzalesTextoACentavos(valor);
  } catch {
    return null;
  }
}

/**
 * Precio en quetzales que el padre recibe en centavos enteros, nunca float.
 *
 * Reporta **al teclear**, no al salir del campo: un Enter que envía el
 * formulario tiene que llevar lo recién escrito. Salir del campo solo
 * normaliza el texto y muestra el error. Pasar el foco sin escribir no
 * reporta nada, así que no convierte un precio de catálogo en uno «a mano».
 */
export function PrecioCampo({
  centavos,
  onChange,
  etiqueta,
  label,
  destacado = false,
  className,
}: {
  centavos: number | null;
  onChange: (centavos: number | null) => void;
  /** Para lectores de pantalla cuando no hay `label` visible. */
  etiqueta: string;
  label?: string;
  /** Resalta que el precio difiere del que tocaba. */
  destacado?: boolean;
  className?: string;
}) {
  const [valor, setValor] = useState(() => texto(centavos));
  const [error, setError] = useState<string | null>(null);
  // Si el padre cambia el valor (p. ej. «usar precios del catálogo» o un
  // refetch), el texto lo sigue. Se ajusta en render, sin efecto.
  const [ultimo, setUltimo] = useState(centavos);
  if (centavos !== ultimo) {
    setUltimo(centavos);
    if (centavos !== parsear(valor)) {
      setValor(texto(centavos));
      setError(null);
    }
  }

  return (
    <TextField
      aria-label={label ? undefined : etiqueta}
      className={cn("w-28", className)}
      isInvalid={error != null}
      value={valor}
      onChange={(v) => {
        setValor(v);
        setError(null);
        const next = parsear(v);
        setUltimo(next);
        onChange(next);
      }}
      onBlur={() => {
        if (valor.trim() === "") return;
        try {
          setValor(texto(quetzalesTextoACentavos(valor)));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Precio inválido");
        }
      }}
    >
      {label ? <Label>{label}</Label> : null}
      <Input
        className={cn(
          "text-right tabular-nums",
          destacado && "border-aviso font-semibold text-aviso",
        )}
        inputMode="decimal"
        placeholder="Q"
      />
      {error ? (
        <Description className="text-peligro">{error}</Description>
      ) : null}
    </TextField>
  );
}
