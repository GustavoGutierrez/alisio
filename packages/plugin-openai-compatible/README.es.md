> Esta es la traducción al español de [README.md](README.md). Ambos archivos deben actualizarse juntos.

# @alisio/plugin-openai-compatible

**El proveedor de modelos compatible con OpenAI integrado en [Alisio](https://github.com/GustavoGutierrez/alisio).**
Apúntalo a cualquier endpoint de Chat Completions o Responses (OpenAI, una pasarela o un servidor
local como llama.cpp) y úsalo desde `/connect`.

## Qué es

Un plugin de tipo `model-provider` que registra el proveedor `openai-compatible` en el host de
Alisio. Se distribuye integrado en la CLI `alisio` y está activado por defecto. La configuración y
las credenciales las aporta el registro de proveedores de Alisio; el plugin no guarda secretos por
sí mismo.

## Instalación

Viene preinstalado en la CLI `alisio`. Para un host embebido, regístralo mediante la lista
`builtins` de `createApplication`.

## Uso: `/connect`

1. Ejecuta `alisio`, luego `/connect` y elige **OpenAI compatible**.
2. Campos: **Base URL** (por defecto `https://api.openai.com/v1`), **API key** (secreto,
   opcional), **API key environment variable** (por defecto `OPENAI_API_KEY`), **API mode**
   (`chat` o `responses`), **Authentication** (`bearer` o `none`), **Token parameter**
   (`max_tokens`, `max_completion_tokens` u `omit`), **Stream usage** (booleano).
3. Elige un modelo del catálogo descubierto, o escríbelo manualmente cuando el endpoint no expone
   un catálogo `GET /models` (entonces `/connect` pide una ventana de contexto opcional en
   tokens).

La clave se lee primero de la credencial almacenada y después de `process.env[apiKeyEnv]`:

```sh
export OPENAI_API_KEY=...   # nunca pongas la clave en archivos de configuración, perfiles ni READMEs
```

## Funcionalidades

- Descubrimiento de modelos mediante `GET /models`; ventanas de contexto por modelo (se pueden
  sobrescribir por perfil).
- Modos Chat Completions y Responses; autenticación bearer o ninguna; parámetro de tokens
  configurable.
- Llamadas a herramientas, metadatos de uso, deltas de razonamiento y adjuntos de imagen.
- Búsqueda web nativa del proveedor disponible cuando el modo de API es `responses`.
- La configuración heredada `provider` (`baseURL`, `apiKeyEnv`, `model`, `apiMode`, `auth`,
  `tokenParameter`, `streamUsage`) sigue funcionando para el arranque y las ejecuciones sin
  interfaz (headless).

Mientras está registrado, el proveedor también aparece en `/model` y en `alisio doctor`.

## Documentación

[Configuración](https://alisioair.com/configuration) ·
[Plugins](https://alisioair.com/plugins).

## Requisitos

Node.js **>= 22.16** o Bun **>= 1.4.2**.

## Licencia

MIT. Mantenido por Gustavo Gutiérrez Mercado. Código fuente: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.
