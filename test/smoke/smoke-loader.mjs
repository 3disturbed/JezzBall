// Module loader hooks: map the client's absolute-URL imports onto the repo
// so the real browser modules can be loaded in Node for the smoke test.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolve(rawSpecifier, context, next) {
  // The browser modules carry cache-busting queries; files on disk don't.
  const specifier = rawSpecifier.startsWith('/') ? rawSpecifier.split('?')[0] : rawSpecifier;
  if (specifier === '/socket.io/socket.io.esm.min.js') {
    return { url: pathToFileURL(path.join(ROOT, 'test', 'smoke', 'socketio-stub.mjs')).href, shortCircuit: true };
  }
  if (specifier.startsWith('/shared/')) {
    return { url: pathToFileURL(path.join(ROOT, specifier.slice(1))).href, shortCircuit: true };
  }
  if (specifier.startsWith('/js/')) {
    return { url: pathToFileURL(path.join(ROOT, 'public', specifier.slice(1))).href, shortCircuit: true };
  }
  return next(specifier, context);
}
