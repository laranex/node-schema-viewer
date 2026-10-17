#!/usr/bin/env node
// Release guard: every runtime dependency must be an exact version installed from the npm registry, so a published
// package never depends on a vendored tarball, a path, a git URL, a tag or a range.
//
//   node scripts/check-release.mjs [PACKAGE_DIRECTORY]
//
// Exits 1 and names each offending dependency. `npm publish` runs it (prepublishOnly); the packaging test reports it.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REGISTRY = 'https://registry.npmjs.org/';

const root = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

const problems = [];
for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!EXACT.test(spec)) {
        problems.push(`${name}: "${spec}" is not an exact registry version`);
        continue;
    }
    const locked = lock.packages?.[`node_modules/${name}`];
    if (locked?.version !== spec) {
        problems.push(`${name}: package-lock.json has ${JSON.stringify(locked?.version ?? null)}, not ${spec}`);
    } else if (typeof locked.resolved !== 'string' || !locked.resolved.startsWith(REGISTRY)) {
        problems.push(`${name}: package-lock.json resolves it from ${JSON.stringify(locked.resolved ?? null)}, not ${REGISTRY}`);
    }
}

if (problems.length > 0) {
    console.error('Not releasable: dependencies must be exact versions from the npm registry.');
    problems.forEach((p) => console.error(`  ${p}`));
    process.exit(1);
}
console.log('Release dependencies: exact registry versions.');
