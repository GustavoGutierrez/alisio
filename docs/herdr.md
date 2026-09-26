# Integración con Herdr

Adaptador custom implementado según la documentación oficial de Herdr y contrastado con
el esquema exportado por el binario **Herdr 0.9.1**, protocolo **22**.

Fuentes:
- https://herdr.dev/docs/integrations/#integrate-your-own-agent
- https://herdr.dev/docs/cli-reference/
- https://herdr.dev/docs/socket-api/

## Reportes

| Evento de Alisio | Estado Herdr |
| --- | --- |
| CLI lista para recibir entrada | idle |
| run_started | working |
| run_completed / run_cancelled | idle |
| run_failed | blocked, con mensaje breve |
| Cierre | pane release-agent |

Comandos utilizados:

```sh
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
  --source custom:alisio --agent alisio --state working \
  --seq SEQUENCE --agent-session-id SESSION_ID

"$HERDR_BIN_PATH" pane release-agent "$HERDR_PANE_ID" \
  --source custom:alisio --agent alisio --seq SEQUENCE
```

Los reportes se serializan, tienen secuencia creciente y timeout. Fuera de Herdr son no-op.
Un fallo de reporte se informa en stderr y no invalida una edición ya terminada.
Herdr puede derivar visualmente “done”; la integración reporta los estados semánticos documentados,
no inventa un estado lifecycle `done`.

## Comunicación con agentes

`--allow-agents` registra operaciones de listar, leer, enviar prompt y esperar. Descubra
primero el destino; use un nombre único o pane ID. No se crean agentes ni paneles como
efecto implícito, ni se cambia el foco. La herramienta de espera es acotada a 60 segundos.
El modelo puede volver a esperar si el trabajo continúa.

Los mensajes son texto entre terminales de agentes, no un protocolo A2A implementado por Alisio.
Un estado idle no certifica éxito: lea el resultado. Una desconexión no dispara un reenvío.
Evite órdenes circulares y edición concurrente de los mismos archivos; use worktrees cuando proceda.

Para que otro agente envíe trabajo a Alisio, mantenga su CLI interactiva abierta en un panel
Herdr y apunte a ese pane ID. La entrada se procesa por turnos. No se usa `run --json` como
servidor de entrada; ese comando ejecuta una sola solicitud y termina.

## Validación realizada y pendiente

- Pruebas automáticas del adaptador: estados, orden, secuencias, cierre y no-op fuera de Herdr.
- Pruebas de comandos de mensajería sin shell y protección frente a envío al propio pane ID.
- Ejecución de `herdr --version` y exportación de `herdr api schema --json` en 0.9.1.
- Verificación del parser real: `agent prompt` recibe el texto como argumento posicional;
  no admite insertar `--` antes del texto en esa versión.
- **Pendiente:** prueba completa con servidor Herdr, PTY y dos agentes reales. El entorno
  de desarrollo bloqueó sockets Unix/arranque del servidor con `Operation not permitted`.
  Esto impide afirmar que ese escenario end-to-end ya está validado.

Se incluye `fixtures/herdr-cli-test.ts`, que usa la CLI oficial contra un receptor local del
protocolo para comprobar los mensajes reales. En una máquina con sockets Unix disponibles:

```sh
HERDR_TEST_BIN="$(command -v herdr)" pnpm test:herdr
```

Esa prueba valida el contrato CLI/IPC con un receptor de pruebas. Después pruebe el escenario
real: abra Herdr, lance Alisio en dos paneles, liste agentes, envíe una tarea entre paneles,
espere el estado idle/blocked y lea la salida. Verifique también cancelación y salida.

No se implementó restauración automática del proceso Alisio desde Herdr: publicar un
session ID no añade por sí mismo un launcher/resumer al catálogo de Herdr.
