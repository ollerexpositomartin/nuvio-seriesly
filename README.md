# Nuvio — Plugin series.ly (Español/Latino/Subtitulado, con sesión)

Plugin nativo de **Nuvio Media** que obtiene streams de **series.ly** para
películas y series a partir de su **TMDB id**, usando **tu propia sesión** de
series.ly (la web exige login para ver los enlaces).

Devuelve enlaces en **Castellano**, **Latino** y **Subtitulado** de servidores
habituales (FILEMOON, STREAMWISH, STREAMTAPE, BYSE, VIDSONIC, LULUSTREAM…).

Desde la **v1.1.0** las cookies de sesión y las preferencias se configuran
**desde la propia app de Nuvio** (Settings → Plugins → *series.ly* → ajustes):
**ya no hace falta editar código ni tocar ningún servidor**.

- **Id:** `seriesly-provider`
- **Versión:** 1.1.0 (`hasSettings: true` — pantalla de ajustes propia en Nuvio)
- **Tipos soportados:** `movie`, `tv`
- **Formato de salida:** `[{ name, title, url, quality, headers }]`
- **Runtime:** Hermes (React Native) — un único archivo CommonJS ES2017, sin
  dependencias externas (solo `fetch` global y regex).

## Estructura

```
nuvio-seriesly/
├── manifest.json          # manifest del repo (array con 1 plugin, hasSettings)
├── src/
│   └── seriesly.js        # fuente del provider (único archivo, CommonJS)
├── providers/
│   └── seriesly.js        # build final (copia/bundle del fuente, Hermes)
├── build.js               # build con esbuild (formato cjs, target es2017)
├── test.js                # test con fetch mockeado + fixtures (sin red)
├── tests/
│   └── fixtures/          # HTML de ejemplo (Matrix 8 enlaces, Silo 1x1 45;
│                          #   copiados de nuvio-seriesly-addon/tests/fixtures)
└── package.json
```

## 1. Cómo obtener tus cookies de sesión

series.ly solo muestra enlaces a usuarios registrados, así que el plugin
necesita **dos cookies de tu navegador**:

1. Entra en <https://series.ly> e **inicia sesión** con tu cuenta.
2. Pulsa **F12** (o clic derecho → *Inspeccionar*) y ve a la pestaña
   **Application** (Chrome/Edge) o **Almacenamiento** (Firefox).
3. En el panel lateral: **Cookies → https://series.ly**.
4. Copia el **Value** de estas dos cookies:
   - `seriesly_session` → cópiala **tal cual** (suele terminar en `%3D`).
   - `XSRF-TOKEN` → cópiala también **tal cual**; el plugin acepta el valor
     URL-encoded o decodificado y normaliza ambos formatos automáticamente.

> En Chrome también puedes usar la consola:
> `document.cookie` no muestra estas cookies (son `HttpOnly`), así que usa
> siempre la pestaña Application → Cookies.

## 2. Configuración DENTRO de Nuvio (sin editar código)

Con el plugin instalado (ver apartado 4):

1. En Nuvio ve a **Settings → Plugins**.
2. Abre los **ajustes** del plugin **series.ly** (icono de engranaje /
   *Settings* del plugin; el manifest declara `hasSettings: true`).
3. Rellena la pantalla que define `onSettings()`:
   - **Cookie seriesly_session** y **Cookie XSRF-TOKEN**: pega los valores
     copiados en el paso 1 (se guardan como campos de contraseña).
   - **Idioma preferido**: *Castellano primero* (por defecto), *Latino
     primero* o *Todos* (respeta el orden original de la página).
   - **Incluir subtitulado**: interruptor para mostrar/ocultar los enlaces
     subtitulados (activado por defecto).
4. Guarda y listo: Nuvio pasa esos valores al plugin en cada consulta a
   través de `globalThis.SCRAPER_SETTINGS`. Cada usuario configura los suyos
   en su dispositivo, sin tocar archivos.

> **Compatibilidad:** si los ajustes de la app están vacíos, el plugin usa
> como *fallback* las constantes `SESSION_COOKIE` / `XSRF_TOKEN` del propio
> archivo (las cookies de **prueba** incluidas están suspendidas y solo
> sirven como ejemplo de formato). Si no hay sesión en ninguno de los dos
> sitios, devuelve `[]` y avisa por consola de que configures los ajustes.

## 3. Caducidad de la sesión (y suspensiones)

- La sesión de series.ly **caduca aproximadamente al mes**. Cuando el plugin
  empiece a devolver 0 enlaces, repite el paso 1 y actualiza las cookies en
  los **ajustes del plugin dentro de Nuvio** (el plugin lo avisa por consola:
  `sesión series.ly caducada`).
- **OJO:** series.ly limita la frecuencia de peticiones (HTTP 429) y puede
  **suspender la cuenta unas semanas** por «exceso de peticiones». El plugin
  ya va dosificado (concurrencia baja, reintentos con espera y un tope de 24
  enlaces resueltos por consulta), pero evita ejecutar `test.js` en bucle o
  reintentar de forma compulsiva. Si te suspenden, toca esperar al plazo
  indicado en <https://series.ly/suspendido> — el plugin también detecta ese
  estado y lo registra por consola.

## 4. Instalación en Nuvio

### Opción A — Desde URL (repositorio)

1. Sube esta carpeta a un repositorio accesible por HTTPS (GitHub, etc.) de
   modo que `manifest.json` quede en una URL raw, p. ej.:
   `https://raw.githubusercontent.com/<usuario>/nuvio-seriesly/main/manifest.json`
2. En Nuvio ve a **Settings → Plugins** (Ajustes → Plugins).
3. Pulsa **Añadir repositorio / Add repo** y pega la URL del `manifest.json`.
4. Activa el plugin **series.ly (Español/Latino, con sesión)** en la lista.

### Opción B — Carga local

1. Copia `providers/seriesly.js` al dispositivo (sin editar nada).
2. En **Settings → Plugins** usa la opción de **importar/cargar plugin local**
   y selecciona ese archivo.
3. Abre los **ajustes del plugin** y pega tus cookies (paso 2).

Una vez instalado y configurado, al abrir cualquier película o episodio Nuvio
llamará a `getStreams(tmdbId, mediaType, season, episode)` y los enlaces de
series.ly aparecerán junto al resto de fuentes.

## Desarrollo

```bash
npm install          # instala esbuild (solo para el build; el provider no tiene deps)
npm run build        # src/seriesly.js -> providers/seriesly.js
npm test             # test offline: fetch mockeado + fixtures (26 checks)
```

Notas:

- `node build.js` usa esbuild (`format: cjs`, `target: es2017`,
  `platform: neutral`). Si esbuild no está disponible, copia el fuente tal
  cual: el provider ya es un único módulo CommonJS ES2017 sin dependencias.
- El test requiere **node >= 18** y **no toca la red** (la cuenta de prueba
  está suspendida): simula `globalThis.SCRAPER_SETTINGS` y sirve los HTML de
  `tests/fixtures/`. Verifica la lectura de ajustes desde la app, el orden por
  idioma (`es`/`lat`/`all`), el filtro `includeSubbed`, el tope anti
  rate-limit de 24 enlaces, la degradación sin sesión y el blueprint de
  `onSettings()`.

## Cómo funciona (resumen)

1. **Título:** resuelve el título en español desde TMDB
   (`api.themoviedb.org/3/{movie|tv}/{id}` con key pública embebida; si la API
   no responde, degrada a la ficha web `themoviedb.org` vía `og:title`).
2. **Búsqueda:** `POST series.ly/api/search/posts` con
   `{"query": "<título>"}`, cabecera `X-XSRF-TOKEN` y las cookies de sesión;
   elige el post cuyo `tmdb_id` coincide **exactamente** (el `type` es
   `movie` o `serie`).
3. **Enlaces:** `GET` de la página (`/peliculas/{slug}` o
   `/series/{slug}/{S}x{E}`) y extrae con regex los handlers Alpine
   `playLink('https://series.ly/t/{token}', …, { server, quality, language })`
   (un episodio puede tener ~45 enlaces).
4. **Resolución:** `GET /t/{token}` → `{"e":"<iframe src=\"…\">"}`; el `src`
   del iframe es la URL del embed que se devuelve a Nuvio. Se resuelve en
   paralelo con concurrencia limitada, reintentos ante 429/5xx y un tope de
   24 enlaces (ordenados según el ajuste *Idioma preferido*: por defecto
   Castellano → Latino → Subtitulado) para proteger la cuenta del rate-limit.
5. Ante cualquier fallo de red, sesión caducada o cuenta suspendida devuelve
   `[]` (nunca lanza) y lo registra por consola.

## Notas y limitaciones

- El `url` devuelto es el **embed** del servidor (bysekoze, streamwish,
  streamtape…); la extracción final del mp4/m3u8 corre a cargo de los
  extractores estándar del ecosistema (Nuvio/Cloudstream) o del reproductor
  externo.
- Cada stream incluye `headers` con `User-Agent` y `Referer`
  (`https://series.ly/`), necesarios para la reproducción.
- Las cookies incluidas en el código como *fallback* son de **prueba** y solo
  sirven como ejemplo de formato: esa cuenta fue suspendida durante las
  verificaciones y su sesión ya no es válida. **Configura las tuyas en los
  ajustes del plugin dentro de Nuvio antes de usarlo.**
