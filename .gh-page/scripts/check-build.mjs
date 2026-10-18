// Checks the built site: every docs/*.md is a page, every local link and asset resolves under the Pages base, and
// the demo pages load their synthetic shared fixtures with the pinned viewer.
import assert from 'node:assert/strict';
import {readFile, readdir, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {pages} from './prepare-demo.mjs';

const dist = path.resolve(fileURLToPath(new URL('../.vitepress/dist/', import.meta.url)));
const docs = fileURLToPath(new URL('../../docs/', import.meta.url));
const fixtures = new URL('../../node_modules/laranex-schema-viewer-ui/contract/fixtures/valid/', import.meta.url);
const base = '/node-schema-viewer/';
const output = new Set(await readdir(dist));
for (const name of await readdir(docs)) {
    if (name.endsWith('.md')) assert.ok(output.has(name.replace(/\.md$/, '.html')), `Missing page for ${name}`);
}

let checked = 0;
for (const filename of output) {
    if (!filename.endsWith('.html')) continue;
    const html = await readFile(path.join(dist, filename), 'utf8');
    for (const [, value] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const url = new URL(value.replaceAll('&amp;', '&'), `https://example.invalid${base}${filename}`);
        if (url.origin !== 'https://example.invalid') continue;
        assert.ok(url.pathname.startsWith(base), `Wrong base in ${filename}: ${value}`);
        let target = path.resolve(dist, decodeURIComponent(url.pathname.slice(base.length)));
        assert.ok(target.startsWith(dist + path.sep) || target === dist, `Outside the site in ${filename}: ${value}`);
        if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
        assert.ok((await stat(target)).isFile(), `Missing asset or page: ${value} (in ${filename})`);
        checked++;
    }
}
const intro = await readFile(path.join(dist, 'introduction.html'), 'utf8');
assert.ok(intro.includes('/edit/main/docs/introduction.md'), 'Edit links point at docs/');
const home = await readFile(path.join(dist, 'index.html'), 'utf8');
assert.ok(home.includes(`${base}demo/index.html`), 'Embedded demo must retain the Pages base');
const quickStart = await readFile(path.join(dist, 'quick-start.html'), 'utf8');
assert.ok(quickStart.includes('language-bash') && quickStart.includes('shiki'), 'Code highlighting missing');
for (const [page, [fixture]] of Object.entries(pages)) {
    const html = await readFile(path.join(dist, 'demo', page), 'utf8');
    assert.ok(html.includes(`data-snapshot-url="snapshots/${fixture}.json"`), `Demo ${page} loads ${fixture}`);
    assert.deepEqual(await readFile(path.join(dist, 'demo/snapshots', `${fixture}.json`)), await readFile(new URL(`${fixture}.json`, fixtures)));
}
console.log(`Checked ${checked} production links and assets, ${output.size} entries, and ${Object.keys(pages).length} demo pages.`);
