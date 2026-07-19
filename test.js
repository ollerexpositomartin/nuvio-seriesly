#!/usr/bin/env node

/**
 * Test del provider series.ly con fetch MOCKEADO (node >= 18).
 *
 *   node test.js
 *
 * La cuenta de prueba de series.ly sigue SUSPENDIDA, así que ningún test
 * toca la red: se simula globalThis.SCRAPER_SETTINGS (los ajustes que el
 * usuario guarda en la app de Nuvio) y un fetch que sirve los HTML de
 * ejemplo de tests/fixtures/ (sly_matrix.html: 8 enlaces; sly_ep.html:
 * 45 enlaces, copiados del proyecto hermano nuvio-seriesly-addon).
 *
 * Se verifica:
 *   1. onSettings(): blueprint con session/xsrf/language/includeSubbed.
 *   2. Las cookies se leen de SCRAPER_SETTINGS (prioridad sobre el archivo).
 *   3. Fallback: sin ajustes se usan las constantes del archivo.
 *   4. Orden por idioma segun el ajuste "language" ('es'/'lat'/'all').
 *   5. Ajuste "includeSubbed": false filtra los subtitulados (tope 24 intacto).
 *   6. Sin sesión configurada -> [] + aviso de configurar ajustes.
 *   7. manifest.json: hasSettings true y version 1.1.0.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROVIDER_FILE = path.join(__dirname, 'providers', 'seriesly.js');
const FIXTURES_DIR = path.join(__dirname, 'tests', 'fixtures');

// Cookies de PRUEBA (cuenta suspendida; solo valen como ejemplo de formato).
const TEST_SESSION = 'eyJpdiI6IlEyd0JlR0hpdFVKdWVEOUFZRmlWbGc9PSIsInZhbHVlIjoiY01WQVBpdXlNZlVnUWtUc3YyQm4xdHpEdVNSNE1wa1ZvNWZnaWM2MTh5aVJRZlZaWFVzZStnb256cTZlcC9HRFFZYi9pYXpLb1A5YldpZUZIT3hIU2NzcWxSLzcxYjVsRTVyNDlyVnpEck1XckpNZkJVTHNSZ0M3OUVGMG54SUsiLCJtYWMiOiI2MjQ0YzU2Mzk4YWEzODgxNjA5ZWJmN2Y3MDZiYTFmZGQ0ZjFmZGE5MzQwYzdkOGUxZDhjN2YwMDZjYTIzZmFjIiwidGFnIjoiIn0%3D';
const TEST_XSRF = 'eyJpdiI6InEzZ1g1d3hXSHpmMjFRZVJ1L0hjdGc9PSIsInZhbHVlIjoieDMrMWU4OTBpS2gwdkl0N29aMkp2K1UrOVZmbGordnliRHBVdVF1TWcxdnord2FIVDRlVGkwcnowek9Pa2E4b2pSYjRHUkQ0MCtJN0VWS2FrRGo1YUUxQ0xrclMxZ2Z4R05KcFQ2bWozQnMvQWxLcVEySmlYRkZzNzhBZE44TkciLCJtYWMiOiJhMTkzOTllZWFkNDE3ODYxMTMwNjBjN2E3M2U1MGY1NjlhMWJlNWY4YTc3MTczZTY3ZmUwZGM4MTI1ODI1ZWFkIiwidGFnIjoiIn0=';

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? ' -> ' + extra : ''));
  }
}

// ------------------------- fetch mockeado -------------------------

function loadFixture(name) {
  const file = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error('Falta el fixture ' + file + ' (se copian de nuvio-seriesly-addon/tests/fixtures)');
  }
  return fs.readFileSync(file, 'utf8');
}

const matrixHtml = loadFixture('sly_matrix.html');
const epHtml = loadFixture('sly_ep.html');

function makeRes(body, opts) {
  opts = opts || {};
  const status = opts.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status: status,
    url: opts.url || 'https://series.ly/',
    headers: { get: function (h) { return (opts.headers || {})[h] || null; } },
    text: function () { return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)); },
    json: function () { return Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body); }
  };
}

/**
 * Crea un fetch falso que enruta a fixtures/JSON según la URL y registra
 * las cabeceras de sesión recibidas (para verificar SCRAPER_SETTINGS).
 */
function createMockFetch() {
  const calls = { total: 0, search: 0, page: 0, token: 0, cookie: null, xsrfHeader: null };
  const fetchImpl = function (url, options) {
    const u = String(url);
    calls.total++;
    const headers = (options && options.headers) || {};
    if (headers.Cookie) calls.cookie = headers.Cookie;
    if (headers['X-XSRF-TOKEN']) calls.xsrfHeader = headers['X-XSRF-TOKEN'];

    // TMDB API v3: título por id
    const m = u.match(/api\.themoviedb\.org\/3\/(movie|tv)\/(\d+)/);
    if (m) {
      const titles = {
        'movie:603': { title: 'Matrix', original_title: 'The Matrix' },
        'tv:125988': { name: 'Silo', original_name: 'Silo' },
        'tv:60625': { name: 'Rick y Morty', original_name: 'Rick and Morty' }
      };
      const data = titles[m[1] + ':' + m[2]];
      return Promise.resolve(data ? makeRes(data) : makeRes({}, { status: 404 }));
    }

    // Fallback web de TMDB (og:title) cuando no hay API key configurada
    const tw = u.match(/www\.themoviedb\.org\/(movie|tv)\/(\d+)/);
    if (tw) {
      const titles = {
        'movie:603': 'Matrix',
        'tv:125988': 'Silo',
        'tv:60625': 'Rick y Morty'
      };
      const title = titles[tw[1] + ':' + tw[2]] || '';
      return Promise.resolve(makeRes(
        '<!doctype html><html><head><meta property="og:title" content="' + title + '"></head><body></body></html>',
        { url: u }
      ));
    }

    // Búsqueda en series.ly
    if (u === 'https://series.ly/api/search/posts') {
      calls.search++;
      let q = '';
      try { q = JSON.parse(options.body).query; } catch (e) { /* noop */ }
      const postsByQuery = {
        'Matrix': [{ tmdb_id: 603, link: '/peliculas/matrix', title: 'Matrix', type: 'movie' }],
        'Silo': [{ tmdb_id: 125988, link: '/series/silo', title: 'Silo', type: 'serie' }],
        // tmdb_id distinto: fuerza el fallback por coincidencia de título.
        'Rick y Morty': [{ tmdb_id: 99999, link: '/series/rick-y-morty', title: 'Rick y Morty', type: 'serie' }]
      };
      return Promise.resolve(makeRes({ posts: postsByQuery[q] || [] }));
    }

    // Páginas de contenido (fixtures)
    if (u === 'https://series.ly/peliculas/matrix') {
      calls.page++;
      return Promise.resolve(makeRes(matrixHtml, { url: u }));
    }
    if (u === 'https://series.ly/series/silo/1x1') {
      calls.page++;
      return Promise.resolve(makeRes(epHtml, { url: u }));
    }
    if (u === 'https://series.ly/series/rick-y-morty/1x1') {
      calls.page++;
      return Promise.resolve(makeRes(
        '<!DOCTYPE html><html><body>' +
        '<button x-on:click="playLink(\'https://series.ly/t/rm001\', \'1\', \'\', { server: \'FILEMOON\', quality: \'HD 1080p\', language: \'Español - España\' })"></button>' +
        '<button x-on:click="playLink(\'https://series.ly/t/rm002\', \'1\', \'\', { server: \'STREAMTAPE\', quality: \'HD 720p\', language: \'Español - Latino\' })"></button>' +
        '</body></html>',
        { url: u }
      ));
    }

    // Resolución de tokens -> embed falso
    const t = u.match(/^https:\/\/series\.ly\/t\/(.+)$/);
    if (t) {
      calls.token++;
      return Promise.resolve(makeRes({ e: '<iframe src="https://embeds.example/e/' + t[1] + '"></iframe>' }));
    }

    return Promise.resolve(makeRes('not found', { status: 404, url: u }));
  };
  return { fetchImpl: fetchImpl, calls: calls };
}

/** Instala el fetch mockeado y unos SCRAPER_SETTINGS dados; devuelve restore(). */
function installMock(settings) {
  const mock = createMockFetch();
  const prevFetch = globalThis.fetch;
  const prevSettings = globalThis.SCRAPER_SETTINGS;
  globalThis.fetch = mock.fetchImpl;
  if (settings === undefined) {
    delete globalThis.SCRAPER_SETTINGS;
  } else {
    globalThis.SCRAPER_SETTINGS = settings;
  }
  return {
    calls: mock.calls,
    restore: function () {
      globalThis.fetch = prevFetch;
      if (prevSettings === undefined) delete globalThis.SCRAPER_SETTINGS;
      else globalThis.SCRAPER_SETTINGS = prevSettings;
    }
  };
}

// ------------------------- escenarios -------------------------

async function testOnSettingsBlueprint(provider) {
  console.log('\n[1] onSettings(): blueprint de ajustes para la app');
  check('exporta onSettings (function)', typeof provider.onSettings === 'function');
  const blueprint = await provider.onSettings();
  check('devuelve un array no vacío', Array.isArray(blueprint) && blueprint.length >= 6);

  const byKey = {};
  blueprint.forEach(function (item) { if (item && item.key) byKey[item.key] = item; });

  check('campo "session" tipo text + isPassword',
    byKey.session && byKey.session.type === 'text' && byKey.session.isPassword === true);
  check('campo "xsrf" tipo text + isPassword',
    byKey.xsrf && byKey.xsrf.type === 'text' && byKey.xsrf.isPassword === true);

  const lang = byKey.language;
  const values = lang && Array.isArray(lang.options) ? lang.options.map(function (o) { return o.value; }) : [];
  check('select "language" con opciones es/lat/all y defaultValue "es"',
    !!lang && lang.type === 'select' && lang.defaultValue === 'es' &&
    values.indexOf('es') !== -1 && values.indexOf('lat') !== -1 && values.indexOf('all') !== -1,
    JSON.stringify(values));

  check('toggle "includeSubbed" con defaultValue true',
    byKey.includeSubbed && byKey.includeSubbed.type === 'toggle' && byKey.includeSubbed.defaultValue === true);
  check('toggle "allowTitleFallback" con defaultValue true',
    byKey.allowTitleFallback && byKey.allowTitleFallback.type === 'toggle' && byKey.allowTitleFallback.defaultValue === true);
}

async function testSettingsAreRead(provider) {
  console.log('\n[2] Las cookies llegan DESDE SCRAPER_SETTINGS (prioridad sobre el archivo)');
  // Valores centinela distintos de las constantes del archivo: si el plugin
  // leyera el fallback, la Cookie llevaría el prefijo 'eyJpdiI6IlEyd0JlR0hp'.
  const env = installMock({
    session: 'SESION_DESDE_AJUSTES_123%3D',
    xsrf: 'XSRF_DESDE_AJUSTES_456%3D',
    language: 'es',
    includeSubbed: true
  });
  try {
    const streams = await provider.getStreams(603, 'movie');
    check('película Matrix: 8 streams con fetch mockeado', streams.length === 8, 'obtenidos: ' + streams.length);
    check('la Cookie usa la sesión de SCRAPER_SETTINGS',
      !!env.calls.cookie && env.calls.cookie.indexOf('seriesly_session=SESION_DESDE_AJUSTES_123%3D') !== -1,
      env.calls.cookie);
    check('la Cookie NO usa el fallback del archivo',
      !!env.calls.cookie && env.calls.cookie.indexOf('eyJpdiI6IlEyd0JlR0hp') === -1);
    check('la Cookie incluye XSRF-TOKEN de los ajustes (URL-encoded tal cual)',
      !!env.calls.cookie && env.calls.cookie.indexOf('XSRF-TOKEN=XSRF_DESDE_AJUSTES_456%3D') !== -1,
      env.calls.cookie);
    check('el header X-XSRF-TOKEN va URL-decodificado',
      env.calls.xsrfHeader === 'XSRF_DESDE_AJUSTES_456=', String(env.calls.xsrfHeader));
  } finally {
    env.restore();
  }
}

async function testFallbackToFileConstants(provider) {
  console.log('\n[3] Fallback: sin SCRAPER_SETTINGS se usan las constantes del archivo');
  const env = installMock(undefined); // sin ajustes de la app
  // El archivo publicado tiene las constantes vacías por seguridad; para
  // probar el fallback cargamos el provider con cookies de prueba inyectadas.
  const code = fs.readFileSync(PROVIDER_FILE, 'utf8')
    .replace(/^var SESSION_COOKIE = .*$/m, "var SESSION_COOKIE = '" + TEST_SESSION + "';")
    .replace(/^var XSRF_TOKEN = .*$/m, "var XSRF_TOKEN = '" + TEST_XSRF + "';");
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
  const isolated = mod.exports;
  try {
    const streams = await isolated.getStreams(603, 'movie');
    check('sigue funcionando (8 streams)', streams.length === 8, 'obtenidos: ' + streams.length);
    check('la Cookie usa la constante SESSION_COOKIE del archivo',
      !!env.calls.cookie && env.calls.cookie.indexOf('seriesly_session=eyJpdiI6IlEyd0JlR0hp') !== -1,
      env.calls.cookie);
  } finally {
    env.restore();
  }
}

async function testLanguageOrdering(provider) {
  console.log('\n[4] Ajuste "language": orden de los enlaces');
  const base = { session: TEST_SESSION, xsrf: TEST_XSRF, includeSubbed: true };

  // 'es' (defecto): Castellano -> Latino -> Subtitulado
  let env = installMock(Object.assign({}, base, { language: 'es' }));
  try {
    const streams = await provider.getStreams(603, 'movie');
    const langs = streams.map(function (s) { return (s.name.match(/\(([^)]+)\)$/) || [])[1]; });
    check("'es': 8 streams ordenados Castellano,Castellano,Castellano,Latino,...,Subtitulado",
      JSON.stringify(langs) === JSON.stringify(
        ['Castellano', 'Castellano', 'Castellano', 'Latino', 'Latino', 'Latino', 'Subtitulado', 'Subtitulado']),
      JSON.stringify(langs));
  } finally { env.restore(); }

  // 'lat': Latino primero
  env = installMock(Object.assign({}, base, { language: 'lat' }));
  try {
    const streams = await provider.getStreams(603, 'movie');
    const langs = streams.map(function (s) { return (s.name.match(/\(([^)]+)\)$/) || [])[1]; });
    check("'lat': los 3 primeros son Latino, luego Castellano y al final Subtitulado",
      JSON.stringify(langs) === JSON.stringify(
        ['Latino', 'Latino', 'Latino', 'Castellano', 'Castellano', 'Castellano', 'Subtitulado', 'Subtitulado']),
      JSON.stringify(langs));
  } finally { env.restore(); }

  // 'all': se respeta el orden original de la página (tokens del fixture)
  env = installMock(Object.assign({}, base, { language: 'all' }));
  try {
    const streams = await provider.getStreams(603, 'movie');
    const tokens = streams.map(function (s) { return s.url.replace('https://embeds.example/e/', ''); });
    check("'all': orden de la página intacto",
      JSON.stringify(tokens) === JSON.stringify(
        ['a1B2c3D4e5', 'f6G7h8I9j0', 'k1L2m3N4o5', 'p6Q7r8S9t0', 'u1V2w3X4y5', 'z6A7b8C9d0', 'e1F2g3H4i5', 'j6K7l8M9n0']),
      JSON.stringify(tokens));
  } finally { env.restore(); }
}

async function testIncludeSubbed(provider) {
  console.log('\n[5] Ajuste "includeSubbed": filtrado de subtitulados');
  const base = { session: TEST_SESSION, xsrf: TEST_XSRF, language: 'es' };

  let env = installMock(Object.assign({}, base, { includeSubbed: false }));
  try {
    const streams = await provider.getStreams(603, 'movie');
    const sub = streams.filter(function (s) { return s.name.indexOf('(Subtitulado)') !== -1; });
    check('includeSubbed=false: 6 streams (3 Castellano + 3 Latino)', streams.length === 6, 'obtenidos: ' + streams.length);
    check('includeSubbed=false: ninguno subtitulado', sub.length === 0);
    check('includeSubbed=false: solo se resolvieron 6 tokens', env.calls.token === 6, 'tokens: ' + env.calls.token);
  } finally { env.restore(); }

  // Con includeSubbed=true la serie Silo (45 enlaces) mantiene el tope de 24.
  env = installMock(Object.assign({}, base, { includeSubbed: true }));
  try {
    const streams = await provider.getStreams(125988, 'tv', 1, 1);
    const cast = streams.filter(function (s) { return s.name.indexOf('(Castellano)') !== -1; });
    const lat = streams.filter(function (s) { return s.name.indexOf('(Latino)') !== -1; });
    const sub = streams.filter(function (s) { return s.name.indexOf('(Subtitulado)') !== -1; });
    check('Silo 1x1: tope anti rate-limit de 24 resueltos', streams.length === 24 && env.calls.token === 24,
      'streams: ' + streams.length + ', tokens: ' + env.calls.token);
    check('Silo 1x1 con "es": 15 Castellano + 9 Latino + 0 Subtitulado',
      cast.length === 15 && lat.length === 9 && sub.length === 0,
      'cast=' + cast.length + ' lat=' + lat.length + ' sub=' + sub.length);
  } finally { env.restore(); }
}

async function testNoSessionDegradation() {
  console.log('\n[6] Sin sesión configurada: [] + aviso de configurar ajustes');
  // El archivo publicado trae cookies de prueba como fallback; para probar la
  // degradación "sin sesión" se carga el provider con las constantes vacías
  // en un módulo aislado (misma fuente, credenciales en blanco).
  const code = fs.readFileSync(PROVIDER_FILE, 'utf8')
    .replace(/^var SESSION_COOKIE = .*$/m, "var SESSION_COOKIE = '';")
    .replace(/^var XSRF_TOKEN = .*$/m, "var XSRF_TOKEN = '';");
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
  const isolated = mod.exports;

  const env = installMock({}); // ajustes de la app vacíos (usuario sin configurar)
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = function (msg) { warnings.push(String(msg)); };
  try {
    const streams = await isolated.getStreams(603, 'movie');
    check('devuelve [] (sin lanzar)', Array.isArray(streams) && streams.length === 0);
    check('no hace NINGUNA petición de red', env.calls.total === 0, 'llamadas: ' + env.calls.total);
    check('avisa por consola de configurar los ajustes',
      warnings.some(function (w) { return /ajustes|settings/i.test(w); }),
      JSON.stringify(warnings));
  } finally {
    console.warn = prevWarn;
    env.restore();
  }
}

async function testTitleFallback(provider) {
  console.log('\n[7] Fallback por título cuando series.ly no tiene el tmdb_id exacto');
  const env = installMock({ session: TEST_SESSION, xsrf: TEST_XSRF, language: 'es', includeSubbed: true, allowTitleFallback: true });
  try {
    const streams = await provider.getStreams(60625, 'tv', 1, 1);
    check('Rick y Morty 1x1: encuentra streams por coincidencia de título', streams.length >= 2, 'obtenidos: ' + streams.length);
    const cast = streams.filter(function (s) { return s.name.indexOf('(Castellano)') !== -1; });
    const lat = streams.filter(function (s) { return s.name.indexOf('(Latino)') !== -1; });
    check('Rick y Morty: al menos 1 Castellano y 1 Latino', cast.length >= 1 && lat.length >= 1,
      'cast=' + cast.length + ' lat=' + lat.length);
  } finally {
    env.restore();
  }

  // Con el fallback desactivado no debe encontrar nada (tmdb_id no coincide).
  const env2 = installMock({ session: TEST_SESSION, xsrf: TEST_XSRF, language: 'es', includeSubbed: true, allowTitleFallback: false, diagnostico: false });
  try {
    const streams = await provider.getStreams(60625, 'tv', 1, 1);
    check('allowTitleFallback=false: no devuelve streams si tmdb_id no coincide', streams.length === 0, 'obtenidos: ' + streams.length);
  } finally {
    env2.restore();
  }
}

function testManifest() {
  console.log('\n[8] manifest.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const entry = Array.isArray(manifest)
    ? manifest[0]
    : (manifest.scrapers && manifest.scrapers[0]) || manifest;
  check('hasSettings: true', entry.hasSettings === true);
  check('version 1.2.5', entry.version === '1.2.5', entry.version);
}

// ------------------------- main -------------------------

async function main() {
  const provider = require(PROVIDER_FILE);

  await testOnSettingsBlueprint(provider);
  await testSettingsAreRead(provider);
  await testFallbackToFileConstants(provider);
  await testLanguageOrdering(provider);
  await testIncludeSubbed(provider);
  await testNoSessionDegradation();
  await testTitleFallback(provider);
  testManifest();

  console.log('\n=================================');
  console.log(passed + ' checks OK, ' + failed + ' fallidos');
  if (failed === 0) {
    console.log('✅ TEST SUPERADO');
    process.exit(0);
  } else {
    console.log('❌ TEST FALLIDO');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado en el test:', err);
  process.exit(1);
});
