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

/**
 * Precio en quetzales que el padre recibe en centavos enteros. Se valida al
 * salir del campo; vacío o inválido llega como `null`, nunca como float.
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

  return (
    <TextField
      aria-label={label ? undefined : etiqueta}
      className={cn("w-28", className)}
      isInvalid={error != null}
      value={valor}
      onChange={setValor}
      onBlur={() => {
        if (valor.trim() === "") {
          setError(null);
          onChange(null);
          return;
        }
        try {
          const next = quetzalesTextoACentavos(valor);
          setError(null);
          setValor(texto(next));
          onChange(next);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Precio inválido");
          onChange(null);
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
