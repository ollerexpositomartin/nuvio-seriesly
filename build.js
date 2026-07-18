#!/usr/bin/env node

/**
 * Build script para nuvio-seriesly (estilo github.com/yoruix/nuvio-providers)
 *
 * Empaqueta src/seriesly.js en un único archivo providers/seriesly.js
 * compatible con Hermes (CommonJS, ES2017).
 *
 * Uso:
 *   node build.js           # build de seriesly
 *   node build.js seriesly  # idem
 *
 * Si esbuild no está disponible (npm install esbuild falló), el script copia
 * el fuente tal cual: el provider está escrito como un único módulo CommonJS
 * ES2017 sin dependencias, por lo que la copia es igualmente válida.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SRC_FILE = path.join(__dirname, 'src', 'seriesly.js');
const OUT_DIR = path.join(__dirname, 'providers');
const OUT_FILE = path.join(OUT_DIR, 'seriesly.js');

async function build() {
  if (!fs.existsSync(SRC_FILE)) {
    console.error(`❌ No existe ${SRC_FILE}`);
    process.exit(1);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let esbuild = null;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    esbuild = null;
  }

  const banner = `/**\n * seriesly - Built from src/seriesly.js\n * Generated: ${new Date().toISOString()}\n */`;

  if (esbuild) {
    await esbuild.build({
      entryPoints: [SRC_FILE],
      bundle: true,
      outfile: OUT_FILE,
      format: 'cjs',        // CommonJS: module.exports compatible con Nuvio
      platform: 'neutral',  // sin APIs de Node en el runtime Hermes
      target: 'es2017',     // async/await nativo soportado por Hermes
      minify: false,        // legible para depuración
      sourcemap: false,
      banner: { js: banner },
      logLevel: 'warning'
    });
  } else {
    console.warn('⚠️  esbuild no disponible; copiando el fuente (CommonJS ES2017, válido igualmente).');
    fs.copyFileSync(SRC_FILE, OUT_FILE);
  }

  const sizeKB = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`✅ providers/seriesly.js (${sizeKB} KB)`);
}

build().catch((err) => {
  console.error('❌ Build fallido:', err && err.message ? err.message : err);
  process.exit(1);
});
