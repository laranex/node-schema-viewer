// A module in a fake project that must never load in the introspection worker.
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'loaded-marker'), 'loaded');
throw new Error('hostile module loaded');
