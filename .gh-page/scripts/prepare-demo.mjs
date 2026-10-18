// Copies the viewer exactly as `node-schema-viewer serve` serves it (the files the manifest of the installed, exactly
// pinned laranex-schema-viewer-ui dependency lists) into public/demo, with synthetic shared contract fixtures as its
// snapshots. Run `npm ci` in the repository root first. Nothing is vendored: public/demo and public/logo.svg are
// generated and ignored by git.
import {copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const demoDirectory = new URL('../public/demo/', import.meta.url);
const ui = new URL('../../node_modules/laranex-schema-viewer-ui/', import.meta.url);
const viewer = new URL('dist/viewer/', ui);
const fixtures = new URL('contract/fixtures/valid/', ui);

// page -> [shared valid fixture, title]
export const pages = {
    'index.html': ['combined-multi-connection', 'Three connections · combined'],
    'compare.html': ['comparison-multi-connection', 'Primary and replica compared · database'],
};

export async function prepareDemo() {
    if (!existsSync(new URL('manifest.json', viewer))) {
        throw new Error('node_modules/laranex-schema-viewer-ui is missing; run npm ci in the repository root first');
    }
    const ownPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const manifest = JSON.parse(await readFile(new URL('manifest.json', viewer), 'utf8'));
    if (manifest.version !== ownPackage.dependencies['laranex-schema-viewer-ui']) {
        throw new Error(`Installed viewer ${manifest.version} is not the pinned dependency; run npm ci in the repository root`);
    }
    await rm(demoDirectory, {recursive: true, force: true});
    for (const {path} of manifest.files) {
        const target = new URL(path, demoDirectory);
        await mkdir(dirname(fileURLToPath(target)), {recursive: true});
        await copyFile(new URL(path, viewer), target);
    }
    // The site's logo is the viewer's favicon: the shared brand mark.
    await copyFile(new URL('favicon.svg', viewer), new URL('../public/logo.svg', import.meta.url));
    const template = await readFile(new URL(manifest.entry.page, viewer), 'utf8');
    if (!template.includes('data-snapshot-url="snapshot.json"')) {
        throw new Error('The viewer page changed how it loads the snapshot; update prepare-demo.mjs');
    }
    await mkdir(new URL('snapshots/', demoDirectory), {recursive: true});
    for (const [page, [fixture, title]] of Object.entries(pages)) {
        await copyFile(new URL(`${fixture}.json`, fixtures), new URL(`snapshots/${fixture}.json`, demoDirectory));
        const html = template
            .replace('data-snapshot-url="snapshot.json"', `data-snapshot-url="snapshots/${fixture}.json"`)
            .replace('<title>Laranex Schema Viewer</title>', `<title>${title} · Laranex Schema Viewer</title>`);
        await writeFile(new URL(page, demoDirectory), html);
    }
    return {manifest};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const {manifest} = await prepareDemo();
    console.log(`Prepared ${Object.keys(pages).length} synthetic demo pages with viewer ${manifest.version}`);
}
