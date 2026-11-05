"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Eye, EyeOff, Lock, User } from "lucide-react";
import { loginRequestSchema, type ActorPublico } from "@misupertostada/shared";
import { Button, Card } from "@heroui/react";
import { toastError, toastFromError } from "@/components/ui/toaster";
import { Wordmark } from "@/components/brand/wordmark";
import { Field } from "@/components/ui/field";
import { detectarEsMobile } from "@/lib/dispositivo";
import { api } from "@/lib/api";
import { seccionInicio } from "@/lib/nav-vista";

type LoginValues = { username: string; password: string };

const pillFieldClassName =
  "flex h-campo w-full items-center gap-3 rounded-pill border border-[var(--border-default)] bg-blanco px-4 shadow-[var(--shadow-inset-field)] transition-[border-color,box-shadow] duration-control ease-out hover:border-[var(--border-strong)] focus-within:border-[var(--border-focus)] focus-within:shadow-foco";

const pillInputClassName =
  "mst-search__input min-w-0 flex-1 appearance-none bg-transparent border-0 p-0 leading-normal text-tinta-800 shadow-none outline-none ring-0 placeholder:text-tinta-500 focus:border-0 focus:outline-none focus:ring-0 focus:shadow-none focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none sm:text-sm";

export default function LoginPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<LoginValues>({
    defaultValues: { username: "", password: "" },
  });

  useEffect(() => {
    if (detectarEsMobile()) return;
    document.getElementById("username")?.focus({ preventScroll: true });
  }, []);

  return (
    <main className="relative flex min-h-[100svh] w-full items-center justify-center overflow-x-hidden bg-[var(--surface-paper)] px-4 py-6 sm:min-h-[100dvh] sm:px-6 sm:py-10">
      {/* Decorative background blurs */}
      <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[min(400px,50vh)] w-[min(800px,120vw)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-marca/10 opacity-60 blur-3xl" aria-hidden />

      <Card className="mx-auto w-full max-w-[26rem] border border-[var(--border-subtle)] bg-blanco shadow-xl sm:max-w-[28rem]">
        <Card.Header className="flex flex-col items-center justify-center gap-2 pb-0 pt-6 sm:pt-10">
          <Wordmark className="mx-auto mb-3 h-44 w-auto max-w-full object-contain object-center sm:mb-4 sm:h-72" />
          <Card.Title className="text-xl font-bold text-tinta-900">
            Iniciar sesión
          </Card.Title>
          <Card.Description className="text-center text-sm font-medium text-tinta-600">
            Ingresa tus credenciales para acceder a tu panel.
          </Card.Description>
        </Card.Header>

        <Card.Content className="px-6 pt-6 pb-8 sm:px-8 sm:pt-8 sm:pb-10">
          <form
            noValidate
            onSubmit={form.handleSubmit(async (values) => {
              const parsed = loginRequestSchema.safeParse(values);
              if (!parsed.success) {
                toastError("Revise usuario y contraseña");
                return;
              }
              try {
                const { usuario } = await api<{ usuario: ActorPublico }>(
                  "/auth/login",
                  {
                    method: "POST",
                    body: JSON.stringify(parsed.data),
                  },
                );
                router.replace(`/${seccionInicio(usuario.rol, usuario.permisos)}`);
              } catch (err) {
                toastFromError(err, "No se pudo entrar");
              }
            })}
          >
            <div className="grid gap-5 text-left">
              <Field label="Usuario" htmlFor="username" required>
                <div className={pillFieldClassName}>
                  <User
                    aria-hidden
                    className="size-[18px] shrink-0 text-tinta-500"
                    strokeWidth={1.75}
                  />
                  <input
                    id="username"
                    autoComplete="username"
                    required
                    placeholder="Tu usuario"
                    className={pillInputClassName}
                    {...form.register("username")}
                  />
                </div>
              </Field>

              <Field label="Contraseña" htmlFor="password" required>
                <div className={pillFieldClassName}>
                  <Lock
                    aria-hidden
                    className="size-[18px] shrink-0 text-tinta-500"
                    strokeWidth={1.75}
                  />
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    placeholder="Tu contraseña"
                    className={pillInputClassName}
                    {...form.register("password")}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-tinta-500 transition-colors hover:bg-[var(--ink-50)] hover:text-tinta-800 focus-visible:outline-none focus-visible:shadow-foco"
                    aria-label={
                      showPassword ? "Ocultar contraseña" : "Mostrar contraseña"
                    }
                  >
                    {showPassword ? (
                      <EyeOff className="size-[18px]" strokeWidth={1.75} />
                    ) : (
                      <Eye className="size-[18px]" strokeWidth={1.75} />
                    )}
                  </button>
                </div>
              </Field>

              <Button
                type="submit"
                className="mt-2 w-full font-semibold shadow-sm"
                isPending={form.formState.isSubmitting}
              >
                Ingresar
              </Button>
            </div>
          </form>
        </Card.Content>
      </Card>
    </main>
  );
}

