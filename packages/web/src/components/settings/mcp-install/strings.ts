/**
 * Texts of installing and managing MCP servers (specs/030 phase 3). Like the Explore texts they live
 * with the settings chunk, not in `i18n/en.ts`: the always-loaded dictionary has a size budget.
 * Same locale signal and `{name}` placeholders as `t()`; EN and ES keep the same keys and
 * placeholders (checked by a test).
 */
import { format } from "../../../i18n/format.ts";
import { locale } from "../../../i18n/index.ts";
import { ageLabel } from "../catalog-model.ts";

const en = {
  "scope.label": "Add it to",
  "scope.project": "Only this project · {name}",
  "scope.global": "All my projects",
  "scope.hintProject": "Other projects will not see it.",
  "scope.hintGlobal": "Every project can use it, each one with its own folders and permissions.",
  "scope.noProject": "No project is selected, so it will be added for all your projects.",
  "action.install": "Install",
  "action.connect": "Connect",
  "action.test": "Check connection",
  "action.configure": "Configure",
  "action.update": "Update",
  "action.signIn": "Sign in",
  "action.signOut": "Sign out",
  "action.retry": "Try again",
  "action.close": "Close",
  "action.cancel": "Cancel",
  "action.recheck": "Check again",
  "action.review": "Review again",
  "action.global": "Add it for all my projects instead",
  "form.title": "Set up {name}",
  "form.lead": "Alisio only asks for what it cannot decide by itself.",
  "form.submitInstall": "Install and test",
  "form.submitConnect": "Connect and test",
  "form.optional": "Optional settings",
  "form.secretHint": "Keys are saved protected on this computer and are never shown again.",
  "form.show": "Show",
  "form.hide": "Hide",
  "form.secretField": "Key",
  "form.summaryLocal": "Runs on this computer",
  "form.summaryRemote": "Connects to {origin}",
  "form.addedTo": "Added to: {where}",
  "form.consentCheck": "I allow Alisio to run MCP servers in this workspace during this session.",
  "form.consentRemember": "Remember my choice for all projects",
  "form.consentWhy": "Connecting runs the server with your user privileges so Alisio can check it.",
  "form.fix": "Check the highlighted fields.",
  "step.label": "Progress",
  "step.prepare": "Preparing it",
  "step.configure": "Saving the settings",
  "step.connect": "Connecting and checking what it offers",
  "progress.waitingConsent": "Waiting for your permission to run it.",
  "progress.working": "Working… You can keep using Alisio.",
  "outcome.connected":
    "Ready. It offers {tools} tools, {resources} resources and {prompts} prompts.",
  "outcome.needsAttention": "Added, but the connection is not complete yet.",
  "outcome.signIn": "Added. This service needs you to sign in to finish connecting.",
  "outcome.signInAction": "Connect my account",
  "outcome.failed": "It could not be added.",
  "outcome.cancelled": "Cancelled. Nothing was changed.",
  "outcome.details": "Technical details",
  "error.untrusted": "This project is not trusted yet, so Alisio cannot add tools to it.",
  "error.conflict": "The settings changed while you were editing. Nothing was written.",
  "error.expired": "This review expired. Review it again.",
  "error.runtime":
    "A component is missing to run this tool: install Node.js, or use the desktop app, which includes it.",
  "error.unsupported": "Alisio cannot install this one automatically yet.",
  "error.readOnly": "Alisio is in read-only mode: it cannot add tools.",
  "error.notFound": "That entry is no longer in the catalog. Update the catalog and try again.",
  "error.input": "Some information is missing or not valid.",
  "error.failed": "The installation did not finish. Nothing was left behind.",
  "error.generic": "It could not be added. Try again.",
  "err.required": "This field is required.",
  "err.choice": "Pick one of the options.",
  "err.number": "Enter a number.",
  "err.boolean": "Choose true or false.",
  "err.control": "Remove line breaks and special characters.",
  "err.spaces": "Remove the spaces at the start or end.",
  "err.long": "This value is too long.",
  "unsupported.pypi":
    "Python (PyPI) servers cannot be installed automatically yet. Follow the server's own instructions to set it up by hand.",
  "unsupported.oci":
    "Container (OCI) servers cannot be installed automatically yet. Follow the server's own instructions to set it up by hand.",
  "unsupported.mcpb":
    "MCPB bundles cannot be installed automatically yet. Follow the server's own instructions to set it up by hand.",
  "unsupported.sse": "This service uses the older SSE transport, which is not supported yet.",
  "unsupported.unversioned":
    "This package does not pin an exact version, so Alisio will not install it automatically.",
  "unsupported.registry":
    "This package comes from a registry other than npm, which is not supported yet.",
  "unsupported.lifecycle_scripts":
    "This package needs install scripts, which Alisio never runs automatically. Follow the server's own instructions to set it up by hand.",
  "unsupported.bin_ambiguous":
    "This package offers several programs and Alisio will not guess which one to run.",
  "unsupported.no_bin": "This package does not declare a program to run.",
  "unsupported.requires_arguments":
    "This server needs command-line arguments that cannot be filled in automatically.",
  "unsupported.unsafe_address":
    "The address of this service was refused for safety (it must be a public HTTPS address).",
  "unsupported.deprecated": "Its publisher marked it as deprecated, so it cannot be installed.",
  "unsupported.deleted": "Its publisher removed it, so it cannot be installed.",
  "unsupported.npm_missing": "Node.js (npm) is needed to install this one.",
  "unsupported.no_method": "This entry has nothing Alisio can install.",
  "unsupported.other":
    "This installation method is not supported yet. Follow the server's own instructions to set it up by hand.",
  "badge.local": "On this computer",
  "badge.localServer": "On the computer running Alisio",
  "badge.remote": "Remote service",
  "badge.scopeGlobal": "Global · All my projects",
  "badge.scopeProject": "Project · {name}",
  "state.connected": "Connected",
  "state.installed": "Installed",
  "state.pending": "Setup pending",
  "state.signInNeeded": "Sign-in needed",
  "test.ready": "Ready to use",
  "test.unchecked": "Not checked",
  "test.attention": "Needs attention",
  "test.stale": "Check again: settings changed",
  "test.checking": "Checking…",
  "test.checkedAt": "Checked {age}",
  "mine.manual": "Set up in a configuration file",
  "mine.empty": "Nothing is connected yet. Explore the catalog to add something.",
  "mine.keys": "Saved key",
  "remove.button": "Remove",
  "remove.buttonDisconnect": "Disconnect",
  "remove.title": "Remove {name}?",
  "remove.titleDisconnect": "Disconnect {name}?",
  "remove.bodyGlobal": "It will be removed from all projects that use this global setting.",
  "remove.bodyProject": "It will be removed only from {name}.",
  "remove.confirm": "Uninstall",
  "remove.confirmDisconnect": "Disconnect service",
  "remove.cancel": "Cancel",
  "remove.secrets": "Also delete the saved key",
  "remove.reveals": "The global setting with the same name will become active again.",
  "remove.account": "Removing it here does not delete your account or cancel any subscription.",
  "remove.shared": "A shared component stays while another project still uses it.",
  "removed.toast": "{name} was removed.",
};

const es: Record<keyof typeof en, string> = {
  "scope.label": "Añadir a",
  "scope.project": "Solo este proyecto · {name}",
  "scope.global": "Todos mis proyectos",
  "scope.hintProject": "Los demás proyectos no lo verán.",
  "scope.hintGlobal":
    "Todos los proyectos pueden usarlo, cada uno con sus propias carpetas y permisos.",
  "scope.noProject":
    "No hay un proyecto seleccionado, así que se añadirá para todos tus proyectos.",
  "action.install": "Instalar",
  "action.connect": "Conectar",
  "action.test": "Comprobar conexión",
  "action.configure": "Configurar",
  "action.update": "Actualizar",
  "action.signIn": "Iniciar sesión",
  "action.signOut": "Cerrar sesión",
  "action.retry": "Reintentar",
  "action.close": "Cerrar",
  "action.cancel": "Cancelar",
  "action.recheck": "Volver a comprobar",
  "action.review": "Revisar de nuevo",
  "action.global": "Añadirlo para todos mis proyectos",
  "form.title": "Configurar {name}",
  "form.lead": "Alisio solo pregunta lo que no puede decidir por sí mismo.",
  "form.submitInstall": "Instalar y comprobar",
  "form.submitConnect": "Conectar y comprobar",
  "form.optional": "Ajustes opcionales",
  "form.secretHint": "Las claves se guardan protegidas en este equipo y no se vuelven a mostrar.",
  "form.show": "Mostrar",
  "form.hide": "Ocultar",
  "form.secretField": "Clave",
  "form.summaryLocal": "Se ejecuta en este equipo",
  "form.summaryRemote": "Se conecta a {origin}",
  "form.addedTo": "Se añadirá a: {where}",
  "form.consentCheck":
    "Permito que Alisio ejecute servidores MCP en este espacio de trabajo durante esta sesión.",
  "form.consentRemember": "Recordar mi elección para todos los proyectos",
  "form.consentWhy":
    "Conectar ejecuta el servidor con tus privilegios de usuario para que Alisio pueda comprobarlo.",
  "form.fix": "Revisa los campos marcados.",
  "step.label": "Progreso",
  "step.prepare": "Preparándolo",
  "step.configure": "Guardando los ajustes",
  "step.connect": "Conectando y comprobando qué ofrece",
  "progress.waitingConsent": "Esperando tu permiso para ejecutarlo.",
  "progress.working": "Trabajando… Puedes seguir usando Alisio.",
  "outcome.connected":
    "Listo. Ofrece {tools} herramientas, {resources} recursos y {prompts} plantillas.",
  "outcome.needsAttention": "Añadido, pero falta completar la conexión.",
  "outcome.signIn":
    "Añadido. Este servicio necesita que inicies sesión para terminar de conectarse.",
  "outcome.signInAction": "Conectar mi cuenta",
  "outcome.failed": "No se pudo añadir.",
  "outcome.cancelled": "Cancelado. No se cambió nada.",
  "outcome.details": "Detalles técnicos",
  "error.untrusted":
    "Este proyecto aún no es de confianza, así que Alisio no puede añadirle herramientas.",
  "error.conflict": "La configuración cambió mientras la editabas. No se escribió nada.",
  "error.expired": "Esta revisión caducó. Revísala de nuevo.",
  "error.runtime":
    "Falta un componente para ejecutar esta herramienta: instala Node.js o usa la aplicación de escritorio, que ya lo incluye.",
  "error.unsupported": "Alisio aún no puede instalar esto automáticamente.",
  "error.readOnly": "Alisio está en modo de solo lectura: no puede añadir herramientas.",
  "error.notFound":
    "Esa ficha ya no está en el catálogo. Actualiza el catálogo e inténtalo de nuevo.",
  "error.input": "Falta información o no es válida.",
  "error.failed": "La instalación no terminó. No quedó nada a medias.",
  "error.generic": "No se pudo añadir. Inténtalo de nuevo.",
  "err.required": "Este campo es obligatorio.",
  "err.choice": "Elige una de las opciones.",
  "err.number": "Escribe un número.",
  "err.boolean": "Elige verdadero o falso.",
  "err.control": "Quita los saltos de línea y los caracteres especiales.",
  "err.spaces": "Quita los espacios del principio o del final.",
  "err.long": "Este valor es demasiado largo.",
  "unsupported.pypi":
    "Los servidores de Python (PyPI) aún no se pueden instalar automáticamente. Sigue las instrucciones del propio servidor para configurarlo a mano.",
  "unsupported.oci":
    "Los servidores en contenedor (OCI) aún no se pueden instalar automáticamente. Sigue las instrucciones del propio servidor para configurarlo a mano.",
  "unsupported.mcpb":
    "Los paquetes MCPB aún no se pueden instalar automáticamente. Sigue las instrucciones del propio servidor para configurarlo a mano.",
  "unsupported.sse": "Este servicio usa el transporte SSE antiguo, que aún no es compatible.",
  "unsupported.unversioned":
    "Este paquete no fija una versión exacta, así que Alisio no lo instalará automáticamente.",
  "unsupported.registry":
    "Este paquete viene de un registro distinto de npm, que aún no es compatible.",
  "unsupported.lifecycle_scripts":
    "Este paquete necesita scripts de instalación, que Alisio nunca ejecuta automáticamente. Sigue las instrucciones del propio servidor para configurarlo a mano.",
  "unsupported.bin_ambiguous":
    "Este paquete ofrece varios programas y Alisio no adivinará cuál ejecutar.",
  "unsupported.no_bin": "Este paquete no declara un programa para ejecutar.",
  "unsupported.requires_arguments":
    "Este servidor necesita argumentos de línea de comandos que no se pueden rellenar automáticamente.",
  "unsupported.unsafe_address":
    "La dirección de este servicio se rechazó por seguridad (debe ser una dirección HTTPS pública).",
  "unsupported.deprecated": "Su publicador lo marcó como obsoleto, así que no se puede instalar.",
  "unsupported.deleted": "Su publicador lo retiró, así que no se puede instalar.",
  "unsupported.npm_missing": "Se necesita Node.js (npm) para instalar esto.",
  "unsupported.no_method": "Esta ficha no tiene nada que Alisio pueda instalar.",
  "unsupported.other":
    "Este método de instalación aún no es compatible. Sigue las instrucciones del propio servidor para configurarlo a mano.",
  "badge.local": "En este equipo",
  "badge.localServer": "En el equipo donde se ejecuta Alisio",
  "badge.remote": "Servicio remoto",
  "badge.scopeGlobal": "Global · Todos mis proyectos",
  "badge.scopeProject": "Proyecto · {name}",
  "state.connected": "Conectado",
  "state.installed": "Instalado",
  "state.pending": "Configuración pendiente",
  "state.signInNeeded": "Falta iniciar sesión",
  "test.ready": "Listo para usar",
  "test.unchecked": "Sin comprobar",
  "test.attention": "Requiere atención",
  "test.stale": "Comprueba de nuevo: cambió la configuración",
  "test.checking": "Comprobando…",
  "test.checkedAt": "Comprobado {age}",
  "mine.manual": "Configurado en un archivo de configuración",
  "mine.empty": "Aún no hay nada conectado. Explora el catálogo para añadir algo.",
  "mine.keys": "Clave guardada",
  "remove.button": "Quitar",
  "remove.buttonDisconnect": "Desconectar",
  "remove.title": "¿Quitar {name}?",
  "remove.titleDisconnect": "¿Desconectar {name}?",
  "remove.bodyGlobal": "Se quitará de todos los proyectos que usan esta configuración global.",
  "remove.bodyProject": "Se quitará solo de {name}.",
  "remove.confirm": "Desinstalar",
  "remove.confirmDisconnect": "Desconectar servicio",
  "remove.cancel": "Cancelar",
  "remove.secrets": "Eliminar también la clave guardada",
  "remove.reveals": "La configuración global con el mismo nombre volverá a estar activa.",
  "remove.account": "Quitarlo aquí no borra tu cuenta ni cancela ninguna suscripción.",
  "remove.shared": "Un componente compartido se conserva mientras otro proyecto lo use.",
  "removed.toast": "Se quitó {name}.",
};

export const installStrings = { en, es };
export type InstallStringKey = keyof typeof en;

/** The text for `key` in the current language, with `{name}` placeholders filled in. */
export const ms = (key: InstallStringKey, params?: Record<string, string | number>): string =>
  format(installStrings[locale.value][key], params);

/** "Checked 3 min ago" for the last connection test. */
export const checkedAgo = (at: string): string =>
  ms("test.checkedAt", { age: ageLabel(Date.parse(at), Date.now(), locale.value) });
