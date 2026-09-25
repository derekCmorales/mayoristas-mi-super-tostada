const { Card, Button, Badge, Icon, EstadoBadge, Tag, MensajePreview, VentanaBadge, Select, Toast, Textarea } = window.MiSPerTostadaDesignSystem_679973;

function ProduccionScreen() {
  const D = window.MST_DATA;
  const grupos = ['PLANTA', 'DEMOCRACIA'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 'var(--space-4)', alignItems: 'start' }}>
      <Card flush padding="md" title="Hoja de producción · versión 2"
        subtitle="Día reabierto a las 22:40 por Cristian · “faltó el pedido de Tabascos”"
        actions={<><Badge tone="amber" size="sm">Reabierto</Badge><Button size="sm" variant="secondary"><Icon name="printer" size={15} />Imprimir</Button></>}>
        {grupos.map((g) => (
          <div key={g}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-4)', background: 'var(--ink-50)', borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)' }}>
              <EstadoBadge estado={g} size="sm" />
              <span className="mst-label">punto de carga</span>
            </div>
            {D.hoja.filter((h) => h.punto === g).map((h) => (
              <div key={h.producto} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 'var(--row-height)', padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border-subtle)', background: h.nuevo ? 'var(--yellow-100)' : 'var(--white)' }}>
                <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 600 }}>{h.producto}</span>
                {h.nota && <Tag tone="accent">{h.nota}</Tag>}
                {h.nuevo && <Badge tone="amber" size="sm">nuevo en v2</Badge>}
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', color: 'var(--green-800)', fontVariantNumeric: 'tabular-nums' }}>{h.cantidad}</span>
                <span style={{ width: 52, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{h.unidad}</span>
              </div>
            ))}
          </div>
        ))}
      </Card>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Card title="Consolidado que recibe Alex" subtitle="Solo tortillas: el resto lo ignora" padding="md">
          <MensajePreview tipo="plantilla" plantilla="hoja_produccion_v2" hora="22:41" estado="entregado"
            cuerpo={'Producción jueves 20 de agosto (v2). Planta: tortilla n.º 16 = 54 lb, tortilla n.º 14 = 60 lb (grosor especial Tabascos). Cambios respecto a la v1 marcados en la hoja impresa.'} />
        </Card>
        <Card title="Reglas aplicadas hoy" padding="md" tone="paper">
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--ink-700)' }}>
            <li>Sábado: toda la carga sale de planta, sin importar el punto de carga del producto.</li>
            <li>La hoja no se materializa hasta el cierre de la ventana.</li>
            <li>Al reabrir no se reenvían mensajes ya enviados.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function ConversacionesScreen() {
  const D = window.MST_DATA;
  const cliente = window.mstCliente;
  const [sel, setSel] = React.useState('v1');
  const conv = D.conversaciones.find((c) => c.id === sel);
  const abierta = conv.ventanaMs > 0;
  const c = cliente(conv.clienteId);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 'var(--space-4)', alignItems: 'start' }}>
      <Card flush padding="md" title="Conversaciones" subtitle="Excepciones de restaurantes">
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {D.conversaciones.map((v) => {
            const activo = v.id === sel;
            const cc = cliente(v.clienteId);
            return (
              <button key={v.id} onClick={() => setSel(v.id)} style={{ display: 'grid', gap: 4, width: '100%', padding: 'var(--space-3) var(--space-4)', border: 0, borderLeft: `3px solid ${activo ? 'var(--green-800)' : 'transparent'}`, borderBottom: '1px solid var(--border-subtle)', background: activo ? 'var(--green-50)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cc.nombre}</span>
                  {v.noLeidos > 0 && <span style={{ minWidth: 18, height: 18, display: 'grid', placeItems: 'center', borderRadius: 999, background: 'var(--red-600)', color: '#fff', fontSize: 10, fontWeight: 700 }}>{v.noLeidos}</span>}
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{v.hora}</span>
                </div>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.ultimo}</span>
                <VentanaBadge abierta={v.ventanaMs > 0} tipo="whatsapp" expiraEn={v.ventanaMs} size="sm" />
              </button>
            );
          })}
        </div>
      </Card>

      <Card flush padding="md" title={c.nombre} subtitle={`${c.tel} · entrega ${c.entrega}`}
        actions={<VentanaBadge abierta={abierta} tipo="whatsapp" expiraEn={conv.ventanaMs} />}>
        <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-4)', borderTop: '1px solid var(--border-subtle)', background: 'var(--cream-100)' }}>
          <MensajePreview tipo="plantilla" plantilla="Aviso de invitación a pedir" hora="20:55" estado="leido"
            cuerpo={'Buenas noches. Ya está abierta la toma de pedidos para mañana jueves 20. Puede responder aquí o abrir su portal.'} />
          <div style={{ justifySelf: 'start', maxWidth: 380, padding: 'var(--space-3)', background: 'var(--green-50)', border: '1px solid var(--green-200)', color: 'var(--text-primary)', borderRadius: '14px 14px 14px 4px', fontSize: 'var(--text-sm)' }}>
            Mañana igual que ayer, gracias
            <div style={{ marginTop: 4, textAlign: 'right', fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>21:02</div>
          </div>
          <MensajePreview tipo="libre" hora="21:05" estado="entregado"
            cuerpo={'Perfecto, Doña Marta. Le dejo anotado:\n• Tortilla grande 40 lb\n• Tostada fina 12 bolsas\n• Papalinas 6 bolsas\nTotal Q 1,240.50, entrega 08:30.'} />
        </div>

        <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--border-subtle)', background: 'var(--white)' }}>
          {abierta ? (
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Textarea rows={2} placeholder="Escriba la respuesta…" hint="El restaurante escribió recientemente. Puede contestar en texto libre." />
              <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', alignItems: 'center' }}>
                <Button size="sm" variant="primary"><Icon name="send" size={15} />Enviar</Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <Toast tone="aviso" title="Solo avisos armados" description="Este restaurante no ha escrito recientemente. Solo puede mandar un aviso ya definido." style={{ maxWidth: '100%' }} />
              <Button size="md" variant="primary"><Icon name="send" size={15} />Mandar estado de cuenta</Button>
              <MensajePreview tipo="plantilla" plantilla="Aviso de estado de cuenta" adjunto="estado-cuenta-agosto.pdf" hora="ahora"
                cuerpo={'Le compartimos su estado de cuenta: 3 facturas pendientes por Q 1,865.00.'} />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

Object.assign(window, { ProduccionScreen, ConversacionesScreen });
