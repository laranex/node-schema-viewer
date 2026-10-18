import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {validateDocument} from 'laranex-schema-viewer-ui/contract';
import {prepareDemo, demoDirectory, pages} from '../scripts/prepare-demo.mjs';

const ui = new URL('../../node_modules/laranex-schema-viewer-ui/', import.meta.url);

test('demo uses the pinned viewer files byte for byte, with relative, base-safe URLs', async () => {
    const {manifest} = await prepareDemo();
    const ownPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.version, ownPackage.dependencies['laranex-schema-viewer-ui']);
    assert.deepEqual(manifest.contract, {format: 'laranex-schema', major: 2});
    for (const {path} of manifest.files) {
        if (path === manifest.entry.page) continue;
        assert.deepEqual(await readFile(new URL(path, demoDirectory)), await readFile(new URL(`dist/viewer/${path}`, ui)), path);
    }
    for (const page of Object.keys(pages)) {
        const html = await readFile(new URL(page, demoDirectory), 'utf8');
        assert.ok(html.includes('href="app.css"') && html.includes('src="app.js"'), page);
        assert.ok(!html.match(/(?:src|href)="\/(?!\/)/), `${page} has a root-relative URL`);
    }
});

test('demo snapshots are synthetic shared laranex-schema 2.0 fixtures', async () => {
    await prepareDemo();
    for (const [page, [fixture]] of Object.entries(pages)) {
        const html = await readFile(new URL(page, demoDirectory), 'utf8');
        assert.ok(html.includes(`data-snapshot-url="snapshots/${fixture}.json"`), page);
        const published = await readFile(new URL(`snapshots/${fixture}.json`, demoDirectory));
        assert.deepEqual(published, await readFile(new URL(`contract/fixtures/valid/${fixture}.json`, ui)));
        const schema = JSON.parse(published.toString('utf8'));
        assert.equal(schema.format, 'laranex-schema');
        assert.equal(schema.version, '2.0');
        assert.deepEqual(validateDocument(schema, {strict: true}).errors, [], fixture);
        assert.ok(schema.connections.length > 1, `${fixture} has several connections`);
    }
});
