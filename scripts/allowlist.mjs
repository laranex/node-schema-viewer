#!/usr/bin/env node
// Writes .laranex-schema-allowlist.json, the reviewed list of synthetic schema documents this repository holds or
// publishes, by exact path and digest (laranex-schema-viewer-ui's allowlistDigest). It lists what the explicit list
// below names, never whatever a scan detects:
// - the conformance recordings from python-schema-viewer (database documents, python-intel documents, and the two MCP
//   recordings whose responses embed a document);
// - the documentation site's demo snapshots, the pinned package's synthetic shared fixtures that
//   .gh-page/scripts/prepare-demo.mjs copies into the built site.
//
//   node scripts/allowlist.mjs [--check]
//
// --check exits 1 when the committed file is not what this would write.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allowlistDigest, canonicalJson } from 'laranex-schema-viewer-ui/contract';
import { pages } from '../.gh-page/scripts/prepare-demo.mjs';

const root = new URL('../', import.meta.url);
const FILE = '.laranex-schema-allowlist.json';
const DIRECTORIES = ['tests/fixtures/conformance/database', 'tests/fixtures/conformance/python-intel/documents'];
const FILES = ['tests/fixtures/conformance/mcp/byte-limit.json', 'tests/fixtures/conformance/mcp/comparison-byte-limit.json'];
const SITE = '.gh-page/.vitepress/dist/demo/snapshots';
const SHARED = fileURLToPath(new URL('contract/fixtures/valid/', import.meta.resolve('laranex-schema-viewer-ui/package.json')));

const digest = (path) => allowlistDigest(new Uint8Array(readFileSync(path)));
const entries = [
    ...DIRECTORIES.flatMap((dir) =>
        readdirSync(new URL(`${dir}/`, root))
            .filter((name) => name.endsWith('.json'))
            .map((name) => `${dir}/${name}`),
    ).map((path) => ({ path, sha256: digest(new URL(path, root)) })),
    ...FILES.map((path) => ({ path, sha256: digest(new URL(path, root)) })),
    ...Object.values(pages).map(([fixture]) => ({ path: `${SITE}/${fixture}.json`, sha256: digest(`${SHARED}${fixture}.json`) })),
].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const text = canonicalJson({ format: 'laranex-schema-allowlist', version: '1.0', entries });
const target = new URL(FILE, root);
if (process.argv.includes('--check')) {
    let current = null;
    try {
        current = readFileSync(target, 'utf8');
    } catch {
        // Reported below.
    }
    if (current !== text) {
        console.error(`${FILE} is not current; run node scripts/allowlist.mjs and review the change`);
        process.exit(1);
    }
} else {
    writeFileSync(target, text);
    console.log(`Wrote ${FILE}: ${entries.length} entries`);
}
