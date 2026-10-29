/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  // tesseract.js lance un worker_thread sur un script résolu depuis son propre
  // dossier : empaqueté par Next, ce chemin pointait dans `.next/` (« Cannot
  // find module .next/worker-script/node/index.js ») et l'OCR plantait. On le
  // laisse donc dans node_modules, chargé tel quel à l'exécution.
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng'],
  // tesseract.js est chargé à l'exécution (voir `runtimeRequire` dans
  // src/lib/ocr.ts) : le traçage du build standalone ne le voit pas, et
  // l'image Docker n'embarquait NI le paquet, NI son worker, NI le cœur WASM,
  // NI les données de langue — l'OCR ne pouvait pas marcher en production.
  // On copie donc explicitement le paquet et ses dépendances.
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/tesseract.js/package.json',
      './node_modules/tesseract.js/src/**/*',
      './node_modules/tesseract.js-core/package.json',
      './node_modules/tesseract.js-core/*.{js,wasm}',
      './node_modules/@tesseract.js-data/eng/{package.json,index.js}',
      './node_modules/@tesseract.js-data/eng/4.0.0_best_int/**/*',
      './node_modules/{bmp-js,idb-keyval,is-url,node-fetch,whatwg-url,tr46,webidl-conversions,regenerator-runtime,wasm-feature-detect,zlibjs}/**/*',
    ],
  },
};

export default nextConfig;
