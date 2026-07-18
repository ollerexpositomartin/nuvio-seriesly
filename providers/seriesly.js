/**
 * series.ly Provider para Nuvio Media
 * -----------------------------------
 * Obtiene streams (España / Latino / Subtitulado) desde series.ly a partir de
 * un TMDB id, usando la sesión del propio usuario (series.ly exige login).
 *
 * Exporta:
 *   async function getStreams(tmdbId, mediaType, season, episode)
 *     - tmdbId:   id numérico (o string) de TMDB
 *     - mediaType: "movie" | "tv"
 *     - season/episode: solo para "tv" (1-based)
 *   Devuelve: [{ name, title, url, quality, headers }]
 *   async function onSettings()
 *     Blueprint de la pantalla de ajustes de Nuvio (cookies de sesión y
 *     preferencias de idioma). Los valores guardados llegan en runtime en
 *     globalThis.SCRAPER_SETTINGS: { session, xsrf, language, includeSubbed }.
 *
 * Compatible con Hermes (React Native): CommonJS, ES2017, solo fetch global y
 * regex. Sin dependencias externas.
 *
 * Pipeline (verificado en vivo 2026-07-18):
 *   0. TMDB id -> título (API v3 + fallback og:title)
 *   1. POST https://series.ly/api/search/posts {"query": título}
 *      -> match exacto por tmdb_id -> link ("/peliculas/x" | "/series/x")
 *   2. GET de la página (película o episodio /series/{slug}/{SxE})
 *      -> regex de los handlers Alpine playLink(urlToken, ..., {server,
 *         quality, language})
 *   3. GET https://series.ly/t/{token} -> {"e":"<iframe src=...>"}
 *      -> el src del iframe es la URL del embed devuelta a Nuvio
 */

'use strict';

// ====================== CREDENCIALES DE SESIÓN (FALLBACK) ======================
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
//  Desde la v1.1.0 NO hace falta editar este archivo: cada usuario pega
//  sus cookies en la PROPIA app de Nuvio
//  (Settings -> Plugins -> "series.ly" -> ajustes; ver onSettings()).
//  Esos valores llegan en globalThis.SCRAPER_SETTINGS y tienen prioridad.
//
//  Estas constantes son solo el FALLBACK (compatibilidad con versiones
//  anteriores / uso fuera de la app): se usan unicamente cuando
//  SCRAPER_SETTINGS no trae valor para la clave correspondiente.
//
//  Cómo obtener las cookies (ver README.md para más detalle):
//    1. Entra en https://series.ly e inicia sesión en tu navegador.
//    2. Pulsa F12 -> pestaña "Application"/"Almacenamiento" -> Cookies
//       -> https://series.ly
//    3. Copia el VALOR de la cookie "seriesly_session" (tal cual aparece,
//       suele terminar en "%3D").
//    4. Copia el VALOR de la cookie "XSRF-TOKEN" (se acepta URL-encoded o
//       decodificado; el plugin normaliza ambos formatos).
//
//  La sesión caduca aproximadamente al mes: cuando el plugin deje de
//  devolver enlaces, repite el proceso y actualiza los ajustes en la app.
//
//  Los valores que hay a continuación son cookies de PRUEBA facilitadas
//  con el proyecto, solo como EJEMPLO de formato. NOTA: esa cuenta de prueba
//  fue suspendida por exceso de peticiones durante las verificaciones y su
//  sesión ya no es válida: cada usuario debe configurar las suyas en la app.
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
var SESSION_COOKIE = ''; // fallback: cookie seriesly_session
var XSRF_TOKEN = ''; // fallback: cookie XSRF-TOKEN

// ============================== Configuración ==============================

var BASE_URL = 'https://series.ly';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
var REQUEST_TIMEOUT_MS = 15000;

// Key pública de TMDB API v3 ampliamente usada por proyectos OSS (Cloudstream).
var TMDB_API_KEY = 'a2c94e83e6c17c9d6dc8b909dd9baf62';

// Prioridad de idioma (menor = antes): España y Latino primero, Subtitulado después.
var LANGUAGE_RULES = [
  [/españ?a/i, 'Castellano', 0],
  [/latino/i, 'Latino', 1],
  [/subtitul/i, 'Subtitulado', 2]
];

// series.ly aplica rate-limit (HTTP 429) y SUSPENDE la cuenta por "exceso de
// peticiones" ante ráfagas (verificado en vivo DOS veces). En el runtime de
// Nuvio NO hay temporizadores, así que las pausas no existen: la única
// protección real es resolver MUY POCOS enlaces y de uno en uno.
var HAS_TIMERS_CFG = typeof setTimeout !== 'function';
var MAX_CONCURRENT_RESOLVES = HAS_TIMERS_CFG ? 1 : 3; // Nuvio: 1 (secuencial)
var RESOLVE_STAGGER_MS = 300;   // pausa entre peticiones (solo si hay timers)
var MAX_LINKS_TO_RESOLVE = HAS_TIMERS_CFG ? 8 : 24;   // Nuvio: solo los 8 mejores
var MAX_RETRIES = 1;            // reintentos mínimos para no multiplicar peticiones

// ====================== Ajustes del usuario (Nuvio) ======================

/**
 * Ajustes guardados por el usuario en la app de Nuvio
 * (Settings -> Plugins -> "series.ly" -> ajustes; ver onSettings()).
 * Nuvio los inyecta en globalThis.SCRAPER_SETTINGS antes de llamar al
 * provider. Fuera de la app (tests, node) puede no existir: fallback {}.
 */
function getSettings() {
  try {
    var s = globalThis.SCRAPER_SETTINGS;
    return s && typeof s === 'object' ? s : {};
  } catch (e) {
    return {};
  }
}

/** Valor de un ajuste de texto: el de SCRAPER_SETTINGS si viene relleno, si no el fallback. */
function settingValue(key, fallback) {
  var v = getSettings()[key];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

/** Cookie seriesly_session efectiva: ajuste de la app o constante del archivo. */
function sessionCookie() {
  return settingValue('session', SESSION_COOKIE);
}

/** Cookie XSRF-TOKEN efectiva: ajuste de la app o constante del archivo. */
function xsrfToken() {
  return settingValue('xsrf', XSRF_TOKEN);
}

// ====================== Diagnóstico (modo pruebas) ======================

/**
 * Motivo del último resultado vacío. La app de Nuvio NO muestra nada cuando
 * getStreams devuelve [] (la pantalla de test solo pinta resultados si hay
 * alguno), así que con el modo diagnóstico activado devolvemos una entrada
 * explicativa para que el usuario vea la causa en la propia app.
 */
var LAST_DIAG = '';

function setDiag(reason) {
  LAST_DIAG = reason;
  log(reason);
}

function diagEnabled() {
  return !!getSettings().diagnostico;
}

function diagStream() {
  return [{
    name: 'series.ly - diagnóstico',
    title: LAST_DIAG || 'Sin resultados: revisa cookies y estado de la cuenta',
    url: 'about:error'
  }];
}

// ============================== Utilidades ==============================

/**
 * fetch con timeout SOLO si hay temporizadores. El runtime de plugins de
 * Nuvio (QuickJS) NO define setTimeout/clearTimeout: llamarlos rompe el
 * plugin ("setTimeout is not defined"). En ese entorno se usa fetch tal cual
 * (la app ya aplica su propio timeout global de 60s a cada ejecución).
 */
var HAS_TIMERS = typeof setTimeout === 'function' && typeof clearTimeout === 'function';

function fetchWithTimeout(url, options, timeoutMs) {
  if (!HAS_TIMERS) {
    return fetch(url, options || {});
  }
  var ms = timeoutMs || REQUEST_TIMEOUT_MS;

  if (typeof AbortController !== 'undefined') {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      try { controller.abort(); } catch (e) { /* noop */ }
    }, ms);
    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts).then(
      function (res) { clearTimeout(timer); return res; },
      function (err) { clearTimeout(timer); throw err; }
    );
  }

  return new Promise(function (resolve, reject) {
    var finished = false;
    var t = setTimeout(function () {
      if (!finished) { finished = true; reject(new Error('timeout after ' + ms + 'ms')); }
    }, ms);
    fetch(url, options || {}).then(
      function (res) { if (!finished) { finished = true; clearTimeout(t); resolve(res); } },
      function (err) { if (!finished) { finished = true; clearTimeout(t); reject(err); } }
    );
  });
}

function log(msg) {
  try { console.warn('[seriesly] ' + msg); } catch (e) { /* noop */ }
}

/**
 * Pausa solo si hay temporizadores; en el runtime de Nuvio (sin setTimeout)
 * se resuelve al instante (la concurrencia limitada ya frena las ráfagas).
 */
function sleep(ms) {
  if (!HAS_TIMERS || !ms) return Promise.resolve();
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * fetchWithTimeout con reintentos ante 429 / 5xx / errores de red.
 * Respeta Retry-After si viene; si no, backoff exponencial con jitter.
 */
function fetchWithRetry(url, options, maxRetries) {
  var retries = typeof maxRetries === 'number' ? maxRetries : MAX_RETRIES;
  var attempt = function (n) {
    return fetchWithTimeout(url, options).then(function (res) {
      if (res && (res.status === 429 || res.status >= 500) && n < retries) {
        var wait = backoffMs(res, n);
        return sleep(wait).then(function () { return attempt(n + 1); });
      }
      return res;
    }, function (err) {
      if (n < retries) {
        return sleep(backoffMs(null, n)).then(function () { return attempt(n + 1); });
      }
      throw err;
    });
  };
  return attempt(0);
}

function backoffMs(res, n) {
  if (res) {
    var ra = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
    var secs = ra ? Number(ra) : NaN;
    if (!isNaN(secs) && secs > 0 && secs <= 30) return secs * 1000;
  }
  // 750ms, 1500ms, 3000ms... + jitter de hasta 400ms
  return 750 * Math.pow(2, n) + Math.floor(Math.random() * 400);
}

/**
 * map con concurrencia limitada: como Promise.all pero con como mucho
 * `limit` trabajos en vuelo. Los resultados conservan el orden de entrada;
 * los errores se convierten en null (nunca se lanzan).
 */
function mapLimit(items, limit, fn) {
  var results = new Array(items.length);
  var next = 0;
  function worker() {
    if (next >= items.length) return Promise.resolve();
    var i = next++;
    return Promise.resolve()
      .then(function () { return fn(items[i], i); })
      .then(function (r) { results[i] = r; }, function () { results[i] = null; })
      .then(worker);
  }
  var workers = [];
  var n = Math.min(limit, items.length);
  for (var k = 0; k < n; k++) workers.push(worker());
  return Promise.all(workers).then(function () { return results; });
}

/** Valor de la cookie XSRF-TOKEN tal como la envía el navegador (URL-encoded). */
function xsrfCookieValue() {
  var token = xsrfToken();
  // Si el usuario pegó el token ya decodificado, hay que re-codificarlo.
  return token.indexOf('%') === -1 ? encodeURIComponent(token) : token;
}

/** Valor del header X-XSRF-TOKEN (URL-decodificado). */
function xsrfHeaderValue() {
  var token = xsrfToken();
  try { return decodeURIComponent(token); } catch (e) { return token; }
}

/** Headers con la sesión del usuario; todas las peticiones a series.ly los llevan. */
function sessionHeaders(extra) {
  var headers = {
    'User-Agent': USER_AGENT,
    'Cookie': 'seriesly_session=' + sessionCookie() + '; XSRF-TOKEN=' + xsrfCookieValue()
  };
  return Object.assign(headers, extra || {});
}

/** ¿Hay sesión configurada (en los ajustes de la app o en el fallback)? */
function hasSession() {
  return !!sessionCookie() && !!xsrfToken();
}

/** Detecta cuenta suspendida (redirect a /suspendido o su página de aviso). */
function isSuspended(res, body) {
  if (res && res.url && res.url.indexOf('/suspendido') !== -1) return true;
  if (typeof body === 'string' && body.indexOf('plazo del baneo') !== -1) return true;
  return false;
}

/**
 * Detecta sesión caducada: redirect a /ingresar, 401/419 o HTML de login.
 */
function isSessionExpired(res, body) {
  if (res) {
    if (res.status === 401 || res.status === 419) return true;
    var finalUrl = res.url || '';
    if (finalUrl.indexOf('/ingresar') !== -1 || finalUrl.indexOf('/login') !== -1) return true;
  }
  if (typeof body === 'string') {
    if (body.indexOf('"Unauthenticated"') !== -1) return true;
    // Formulario de login (campo password + acción de ingreso).
    if (/type="password"/i.test(body) && /ingresar|iniciar sesi[oó]n|entrar/i.test(body)) return true;
  }
  return false;
}

function warnIfExpired(res, body) {
  if (isSuspended(res, body)) {
    setDiag('Cuenta de series.ly SUSPENDIDA temporalmente por exceso de peticiones');
    return true;
  }
  if (isSessionExpired(res, body)) {
    setDiag('Sesión de series.ly CADUCADA: renueva las cookies en los ajustes del plugin');
    return true;
  }
  return false;
}

/** GET con sesión (con reintentos) que devuelve { res, text } o null ante cualquier fallo. */
function getWithSession(url, extraHeaders) {
  return fetchWithRetry(url, { headers: sessionHeaders(extraHeaders), redirect: 'follow' })
    .then(function (res) {
      return res.text().then(function (text) {
        return { res: res, text: text };
      });
    })
    .catch(function () { return null; });
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ====================== Paso 0: título desde TMDB ======================

/**
 * Devuelve candidatos de título (es-ES y original) para el TMDB id.
 * Misma lógica que el plugin cuevana3: API v3 con key y, si falla,
 * og:title de la web de themoviedb.org.
 */
function resolveTitleCandidates(tmdbId, mediaType) {
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  var apiUrl = 'https://api.themoviedb.org/3/' + kind + '/' + encodeURIComponent(String(tmdbId)) +
    '?api_key=' + TMDB_API_KEY + '&language=es-ES';

  return fetchWithTimeout(apiUrl, { headers: { 'User-Agent': USER_AGENT } })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .catch(function () { return null; })
    .then(function (data) {
      var candidates = [];
      if (data) {
        var main = data.title || data.name;
        var original = data.original_title || data.original_name;
        if (main) candidates.push(main);
        if (original && candidates.indexOf(original) === -1) candidates.push(original);
      }
      if (candidates.length > 0) return candidates;

      var webUrl = 'https://www.themoviedb.org/' + kind + '/' + encodeURIComponent(String(tmdbId)) + '?language=es-ES';
      return fetchWithTimeout(webUrl, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' })
        .then(function (res) { return res && res.ok ? res.text() : null; })
        .catch(function () { return null; })
        .then(function (html) {
          if (!html) return [];
          var m = html.match(/<meta property="og:title" content="([^"]+)"/);
          if (!m) {
            var t = html.match(/<title>([^<]+)<\/title>/);
            if (!t) return [];
            m = [null, t[1].replace(/\s*\(.*?$/g, '').replace(/\s*—.*$/g, '').trim()];
          }
          var title = decodeHtmlEntities(String(m[1]).trim());
          return title ? [title] : [];
        });
    })
    .catch(function () { return []; });
}

/** Variantes de búsqueda a partir de los títulos candidatos. */
function buildQueryVariants(candidates) {
  var seen = {};
  var out = [];
  candidates.forEach(function (title) {
    if (!title) return;
    var variants = [title];
    var noParens = title.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    variants.push(noParens);
    if (title.indexOf(':') !== -1) variants.push(title.split(':')[0].trim());
    variants.forEach(function (v) {
      var k = v.toLowerCase();
      if (v && v.length >= 2 && !seen[k]) {
        seen[k] = true;
        out.push(v);
      }
    });
  });
  return out;
}

// ====================== Paso 1: búsqueda en series.ly ======================

/**
 * POST /api/search/posts {"query": ...}. Devuelve el post cuyo tmdb_id
 * coincide exactamente (normalizado a string), o null.
 */
/** Detalle de los intentos de búsqueda (para el modo diagnóstico). */
var SEARCH_DIAG = '';

function searchOnSeriesly(tmdbId, mediaType, queryVariants) {
  var wanted = String(tmdbId);
  var wantedType = mediaType === 'tv' ? 'serie' : 'movie';
  SEARCH_DIAG = '';

  var attempt = function (index) {
    if (index >= queryVariants.length) return Promise.resolve(null);
    var q = queryVariants[index];

    return fetchWithRetry(BASE_URL + '/api/search/posts', {
      method: 'POST',
      redirect: 'follow',
      headers: sessionHeaders({
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': xsrfHeaderValue(),
        'Referer': BASE_URL + '/'
      }),
      body: JSON.stringify({ query: q })
    }).then(function (res) {
      if (!res) {
        SEARCH_DIAG += ' ["' + q + '": sin respuesta]';
        return attempt(index + 1);
      }
      return res.text().then(function (body) {
        if (warnIfExpired(res, body)) return null;
        if (!res.ok) {
          SEARCH_DIAG += ' ["' + q + '": HTTP ' + res.status +
            (res.statusText ? ' (' + res.statusText + ')' : '') + ']';
          return attempt(index + 1);
        }
        var data = null;
        try { data = JSON.parse(body); } catch (e) { data = null; }
        if (!data || typeof data !== 'object') {
          var snippet = String(body || '').replace(/\s+/g, ' ').slice(0, 60);
          SEARCH_DIAG += ' ["' + q + '": respuesta no-JSON: ' + snippet + ']';
          return attempt(index + 1);
        }
        var posts = data && data.posts;
        if (posts && posts.length) {
          for (var i = 0; i < posts.length; i++) {
            var p = posts[i];
            if (p && String(p.tmdb_id) === wanted && typeof p.link === 'string') {
              // type: "movie" | "serie"; si no viene, se acepta igualmente.
              if (!p.type || p.type === wantedType) return p;
            }
          }
          SEARCH_DIAG += ' ["' + q + '": ' + posts.length + ' posts, ninguno con tmdb_id ' + wanted + ']';
        } else {
          SEARCH_DIAG += ' ["' + q + '": 0 posts]';
        }
        return attempt(index + 1);
      });
    }).catch(function (err) {
      SEARCH_DIAG += ' ["' + q + '": error de red ' + (err && err.message ? err.message : err) + ']';
      return attempt(index + 1);
    });
  };

  return attempt(0);
}

// ====================== Paso 2: página del contenido ======================

/**
 * Extrae los enlaces playLink del HTML.
 * Formato (multi-línea; las clases negadas [^)] cruzan saltos de línea):
 *   x-on:click="playLink('https://series.ly/t/{TOKEN}', '986296', '', {
 *       server: 'FILEMOON', quality: 'HD 1080p', language: 'Español - España', ... })"
 * Devuelve [{ tokenUrl, server, quality, language }].
 */
function extractLinks(html) {
  var links = [];
  if (!html) return links;

  var patterns = [
    // Variante verificada (comillas simples).
    /playLink\('(https:\/\/series\.ly\/t\/[^']+)'[^)]*server:\s*'([^']+)'[^)]*quality:\s*'([^']+)'[^)]*language:\s*'([^']+)'/g,
    // Variante tolerante: comillas escapadas \" (HTML dentro de atributo/JSON).
    /playLink\(\\?["'](https:\/\/series\.ly\/t\/[^\\?"']+)\\?["'][^)]*server:\s*\\?["']([^\\"']+)\\?["'][^)]*quality:\s*\\?["']([^\\"']+)\\?["'][^)]*language:\s*\\?["']([^\\"']+)\\?["']/g
  ];

  var seen = {};
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(html)) !== null) {
      var tokenUrl = m[1];
      if (seen[tokenUrl]) continue;
      seen[tokenUrl] = true;
      links.push({
        tokenUrl: tokenUrl,
        server: m[2],
        quality: m[3],
        language: m[4]
      });
    }
  });
  return links;
}

/**
 * Prioridad efectiva según el ajuste "language" de Nuvio:
 *   'es' / ausente -> Castellano > Latino > Subtitulado (orden por defecto)
 *   'lat'          -> Latino > Castellano > Subtitulado
 *   'all'          -> mismo rank para todos: se respeta el orden de la página
 */
function languageRank(label, defaultRank) {
  var pref = getSettings().language;
  if (pref === 'all') return 0;
  if (pref === 'lat') {
    if (label === 'Latino') return 0;
    if (label === 'Castellano') return 1;
    return 2; // Subtitulado y desconocidos, al final
  }
  return defaultRank;
}

/** Etiqueta corta y prioridad del idioma. */
function mapLanguage(language) {
  var lang = String(language || '');
  for (var i = 0; i < LANGUAGE_RULES.length; i++) {
    if (LANGUAGE_RULES[i][0].test(lang)) {
      return { label: LANGUAGE_RULES[i][1], rank: languageRank(LANGUAGE_RULES[i][1], LANGUAGE_RULES[i][2]) };
    }
  }
  return { label: lang || 'Desconocido', rank: languageRank(null, LANGUAGE_RULES.length) };
}

/** Normaliza "HD 1080p" -> "1080p" cuando es posible. */
function mapQuality(q) {
  var raw = String(q || '').trim();
  var m = raw.match(/(\d{3,4})\s*p/i);
  if (m) return m[1] + 'p';
  if (/^hd$/i.test(raw)) return '720p';
  if (/full\s*hd/i.test(raw)) return '1080p';
  if (/^(sd|cam|ts)$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

// ====================== Paso 3: resolver enlace ======================

/** Detalle del primer fallo de resolución (para el modo diagnóstico). */
var RESOLVE_DIAG = '';

function noteResolveFail(reason) {
  if (!RESOLVE_DIAG) RESOLVE_DIAG = reason;
}

/**
 * GET /t/{token} -> {"e":"<iframe src=\"...\">"}. Extrae el src del iframe.
 * Devuelve { url } | { suspended: true } | null.
 */
function resolveToken(tokenUrl, referer) {
  return getWithSession(tokenUrl, {
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': xsrfHeaderValue(),
    'Referer': referer || BASE_URL + '/'
  }).then(function (r) {
    if (!r) { noteResolveFail('red/HTTP 0 en /t/'); return null; }
    if (isSuspended(r.res, r.text)) return { suspended: true };
    if (!r.res.ok) {
      noteResolveFail('HTTP ' + r.res.status +
        (r.res.statusText ? ' (' + r.res.statusText + ')' : '') + ' en /t/');
      return null;
    }
    var body = r.text || '';
    if (body.indexOf('captcha_required') !== -1) {
      return { captcha: true };
    }
    var html = body;
    try {
      var data = JSON.parse(body);
      if (data && typeof data.e === 'string') html = data.e;
    } catch (e) { /* no era JSON: se intenta regex sobre el cuerpo crudo */ }
    var m = html.match(/src=\\?"([^"\\]+)/);
    if (!m) {
      noteResolveFail('respuesta de /t/ sin iframe: ' + String(body).replace(/\s+/g, ' ').slice(0, 60));
      return null;
    }
    var url = m[1];
    // Solo embeds absolutos y ajenos a series.ly (evita falsos positivos
    // de páginas HTML inesperadas, p. ej. assets de la página de suspensión).
    if (!/^https?:\/\//i.test(url)) return null;
    if (/^https?:\/\/([^\/]*\.)?series\.ly(\/|$)/i.test(url)) return null;
    return { url: url };
  }).catch(function () { return null; });
}

// ====================== Ensamblado de streams ======================

function buildStreams(links, contentTitle, referer) {
  // Ajuste "includeSubbed" (toggle, por defecto true): si el usuario lo
  // desactiva en la app, los enlaces subtitulados se descartan ANTES del
  // orden y del tope de resolución.
  var includeSubbed = getSettings().includeSubbed !== false;

  // Ordenar por idioma (según el ajuste "language"; por defecto
  // Castellano/Latino primero, Subtitulado después), manteniendo el orden
  // de la página dentro de cada idioma.
  var jobs = [];
  links.forEach(function (link, idx) {
    var lang = mapLanguage(link.language);
    if (!includeSubbed && lang.label === 'Subtitulado') return;
    jobs.push({
      idx: idx,
      tokenUrl: link.tokenUrl,
      server: String(link.server || '').toUpperCase(),
      qualityRaw: String(link.quality || '').trim(),
      quality: mapQuality(link.quality),
      langLabel: lang.label,
      langRank: lang.rank
    });
  });
  jobs.sort(function (a, b) {
    var r = a.langRank - b.langRank;
    return r !== 0 ? r : a.idx - b.idx;
  });
  if (jobs.length > MAX_LINKS_TO_RESOLVE) {
    log('demasiados enlaces (' + jobs.length + '); se resuelven los ' + MAX_LINKS_TO_RESOLVE + ' mejores');
    jobs = jobs.slice(0, MAX_LINKS_TO_RESOLVE);
  }

  // Resolver en paralelo pero con concurrencia limitada y ritmo pausado
  // (anti rate-limit / anti-suspensión); cada resolución lleva sus propios
  // reintentos con backoff. Errores -> se omiten (nunca se lanza).
  // Si se detecta suspensión se abortan las resoluciones pendientes.
  var state = { suspended: false, captcha: false };
  return mapLimit(jobs, MAX_CONCURRENT_RESOLVES, function (job, i) {
    if (state.suspended || state.captcha) return null;
    var stagger = i < MAX_CONCURRENT_RESOLVES ? 0 : RESOLVE_STAGGER_MS;
    return sleep(stagger).then(function () {
      return (state.suspended || state.captcha) ? null : resolveToken(job.tokenUrl, referer);
    }).then(function (result) {
      if (!result) return null;
      if (result.captcha) {
        state.captcha = true;
        return null;
      }
      if (result.suspended) {
        state.suspended = true;
        log('cuenta series.ly suspendida temporalmente por exceso de peticiones; abortando resoluciones');
        return null;
      }
      return {
        name: 'series.ly - ' + job.server + ' (' + job.langLabel + ')',
        title: contentTitle + (job.qualityRaw ? ' [' + job.qualityRaw + ']' : ''),
        url: result.url,
        quality: job.quality || undefined,
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': BASE_URL + '/'
        }
      };
    }).catch(function () { return null; });
  }).then(function (streams) {
    var seen = {};
    var out = [];
    streams.forEach(function (s) {
      if (s && s.url && !seen[s.url]) {
        seen[s.url] = true;
        out.push(s);
      }
    });
    if (state.captcha) {
      setDiag('series.ly pide CAPTCHA para resolver enlaces: entra en series.ly desde el navegador, reproduce 2-3 enlaces a mano (resolviendo el captcha si aparece) y vuelve a probar');
    }
    return out;
  });
}

// ====================== Paso 1b: búsqueda por slug directo ======================

/**
 * Convierte un título en slug estilo series.ly: minúsculas, sin acentos,
 * separado por guiones ("Avatar: El camino del agua" -> "avatar-el-camino-del-agua").
 */
function slugify(title) {
  var s = String(title || '').toLowerCase();
  try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* noop */ }
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Plan B cuando la API de búsqueda falla: probar /peliculas/{slug} o
 * /series/{slug} con cada título candidato y validar la página con el enlace
 * a TMDB que incluye (themoviedb.org/movie/{id} | /tv/{id}). Devuelve
 * { link, title } o null.
 */
function findPostBySlug(tmdbId, mediaType, candidates) {
  var section = mediaType === 'tv' ? '/series/' : '/peliculas/';
  var tmdbPath = mediaType === 'tv'
    ? 'themoviedb.org/tv/' + tmdbId
    : 'themoviedb.org/movie/' + tmdbId;

  var attempt = function (index) {
    if (index >= candidates.length) return Promise.resolve(null);
    var slug = slugify(candidates[index]);
    if (!slug) return attempt(index + 1);
    var link = section + slug;

    return getWithSession(BASE_URL + link).then(function (r) {
      if (r && warnIfExpired(r.res, r.text)) return null;
      if (r && r.res && r.res.ok && r.text && r.text.indexOf(tmdbPath) !== -1) {
        SEARCH_DIAG += ' [slug directo OK: ' + link + ']';
        return { link: link, title: candidates[index] };
      }
      if (r && r.res && r.res.status && r.res.status !== 404) {
        SEARCH_DIAG += ' [' + link + ': HTTP ' + r.res.status + ']';
      }
      return attempt(index + 1);
    }).catch(function () {
      return attempt(index + 1);
    });
  };

  return attempt(0);
}

// ====================== Entrada principal ======================

function getStreamsInternal(tmdbId, mediaType, season, episode) {
  return Promise.resolve().then(function () {
    if (!tmdbId || (mediaType !== 'movie' && mediaType !== 'tv')) {
      setDiag('Petición inválida (id o tipo desconocido)');
      return [];
    }
    if (!hasSession()) {
      setDiag('Sin sesión: configura las cookies en los ajustes del plugin (icono ⚙️)');
      return [];
    }

    return resolveTitleCandidates(tmdbId, mediaType).then(function (candidates) {
      var queries = buildQueryVariants(candidates);
      if (!queries.length) {
        setDiag('No se pudo obtener el título desde TMDB (id ' + tmdbId + ')');
        return [];
      }

      return searchOnSeriesly(tmdbId, mediaType, queries).then(function (post) {
        if ((!post || !post.link) && !LAST_DIAG) {
          // Plan B: la API de búsqueda falló (o no hubo match) -> slug directo.
          return findPostBySlug(tmdbId, mediaType, candidates).then(function (bySlug) {
            return bySlug || null;
          });
        }
        return post;
      }).then(function (post) {
        if (!post || !post.link) {
          if (!LAST_DIAG) setDiag('No encontrado en series.ly: TMDB ' + tmdbId + '.' + SEARCH_DIAG);
          return [];
        }

        // link: "/peliculas/{slug}" | "/series/{slug}"
        var pageUrl = BASE_URL + post.link;
        var contentTitle = post.title || candidates[0] || String(tmdbId);
        if (mediaType === 'tv') {
          var s = Number(season) || 1;
          var e = Number(episode) || 1;
          pageUrl += '/' + s + 'x' + e;
          contentTitle += ' ' + s + 'x' + (e < 10 ? '0' + e : e);
        }

        return getWithSession(pageUrl).then(function (r) {
          if (!r) {
            if (!LAST_DIAG) setDiag('Error de red cargando ' + pageUrl);
            return [];
          }
          if (warnIfExpired(r.res, r.text)) return [];
          if (!r.res.ok) {
            setDiag('Página no disponible (' + r.res.status + '): ' + pageUrl);
            return [];
          }
          var links = extractLinks(r.text);
          if (!links.length) {
            setDiag('La página no tiene enlaces: ' + pageUrl);
            return [];
          }
          return buildStreams(links, contentTitle, pageUrl).then(function (streams) {
            if (!streams.length && !LAST_DIAG) {
              setDiag('Había ' + links.length + ' enlaces pero ninguno se pudo resolver.' +
                (RESOLVE_DIAG ? ' Causa: ' + RESOLVE_DIAG : ' Tokens caducados o servidores caídos.'));
            }
            return streams;
          });
        });
      });
    });
  }).catch(function (err) {
    setDiag('Error inesperado: ' + (err && err.message ? err.message : err));
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  LAST_DIAG = '';
  RESOLVE_DIAG = '';
  return getStreamsInternal(tmdbId, mediaType, season, episode).then(function (streams) {
    if ((!streams || !streams.length) && diagEnabled()) return diagStream();
    return streams || [];
  });
}

// ====================== Ajustes en la app (Nuvio) ======================

/**
 * Blueprint de la pantalla de ajustes del plugin en Nuvio
 * (Settings -> Plugins -> "series.ly" -> ajustes). Requiere
 * "hasSettings": true en manifest.json. Los valores que guarda el usuario
 * llegan en runtime en globalThis.SCRAPER_SETTINGS con las claves
 * declaradas en "key" (session, xsrf, language, includeSubbed).
 */
async function onSettings() {
  return [
    { type: 'header', label: 'Cuenta de series.ly' },
    { type: 'info', label: 'Obtén las cookies en series.ly: F12 -> Application -> Cookies (ver README.md)' },
    { type: 'text', key: 'session', label: 'Cookie seriesly_session', placeholder: 'eyJpdiI6...', isPassword: true, description: 'Caduca ~1 mes' },
    { type: 'text', key: 'xsrf', label: 'Cookie XSRF-TOKEN', placeholder: 'eyJpdiI6...', isPassword: true, description: 'Se acepta URL-encoded o decodificada' },
    { type: 'header', label: 'Preferencias' },
    {
      type: 'select', key: 'language', label: 'Idioma preferido', options: [
        { label: 'Castellano primero', value: 'es' },
        { label: 'Latino primero', value: 'lat' },
        { label: 'Todos', value: 'all' }
      ], defaultValue: 'es'
    },
    { type: 'toggle', key: 'includeSubbed', label: 'Incluir subtitulado', defaultValue: true },
    { type: 'header', label: 'Pruebas' },
    { type: 'info', label: 'Activa el modo diagnóstico y pulsa "Probar proveedor" para ver el motivo si no hay streams.' },
    { type: 'toggle', key: 'diagnostico', label: 'Modo diagnóstico', defaultValue: false }
  ];
}

module.exports = { getStreams: getStreams, onSettings: onSettings };
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
