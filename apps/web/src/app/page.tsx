"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api, ApiError } from "@/lib/api";
import { Providers } from "@/components/providers";
import { useQuery } from "@tanstack/react-query";
import type { ActorPublico } from "@misupertostada/shared";
import { seccionInicio } from "@/lib/nav-vista";

function HomeRedirect() {
  const router = useRouter();
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
    retry: false,
  });

  useEffect(() => {
    if (me.data) {
      const { rol, permisos } = me.data.usuario;
      router.replace(`/${seccionInicio(rol, permisos)}`);
    }
    if (me.error instanceof ApiError) router.replace("/login");
  }, [me.data, me.error, router]);

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[var(--surface-page)]">
      <span className="sr-only">Cargando</span>
      <div className="h-10 w-40 animate-pulse rounded-campo bg-[var(--ink-100)]" />
    </main>
  );
}

export default function HomePage() {
  return (
    <Providers>
      <HomeRedirect />
    </Providers>
  );
}
