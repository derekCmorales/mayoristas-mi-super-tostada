CREATE TABLE "factura_ajuste" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"factura_id" uuid NOT NULL,
	"monto_anterior_centavos" integer NOT NULL,
	"monto_nuevo_centavos" integer NOT NULL,
	"motivo" text NOT NULL,
	"registrado_por" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "factura_ajuste" ADD CONSTRAINT "factura_ajuste_factura_id_factura_id_fk" FOREIGN KEY ("factura_id") REFERENCES "public"."factura"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "factura_ajuste" ADD CONSTRAINT "factura_ajuste_registrado_por_usuario_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "factura_ajuste_factura_idx" ON "factura_ajuste" USING btree ("factura_id");
--> statement-breakpoint
ALTER TABLE "pedido_item" ADD COLUMN "precio_manual" boolean DEFAULT false NOT NULL;
