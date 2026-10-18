// Packs the package, installs the tarball into an empty project and runs the installed binary, and reports the release
// guard (scripts/check-release.mjs). Needs the npm registry (or a warm npm cache) for the dependencies.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { adminUrl, serverDatabase, sqliteDatabase } from './databases.js';
import { COMBINED, ROOT, tempDir, VALID } from './helpers.js';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GUARD = join(ROOT, 'scripts', 'check-release.mjs');

function guard(directory: string): { code: number | null; output: string } {
    const run = spawnSync(process.execPath, [GUARD, directory], { encoding: 'utf8' });
    return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('release guard', () => {
    test('this checkout depends only on exact registry versions', () => {
        const result = guard(ROOT);
        assert.equal(result.code, 0, result.output);
    });

    test('accepts exact registry versions and refuses tarballs, paths, ranges, tags and unlocked versions', (t) => {
        const dir = tempDir(t);
        const check = (dependencies: Record<string, string>, packages: Record<string, unknown>): number | null => {
            writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies }));
            writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
            return guard(dir).code;
        };
        const registry = (version: string) => ({ version, resolved: `https://registry.npmjs.org/a/-/a-${version}.tgz` });
        assert.equal(check({ a: '1.2.3' }, { 'node_modules/a': registry('1.2.3') }), 0);
        assert.equal(check({ a: '0.3.0-rc.1' }, { 'node_modules/a': registry('0.3.0-rc.1') }), 0);
        for (const spec of ['file:vendor/a-1.0.0.tgz', '^1.2.3', '~1.2.3', 'latest', '1.x', 'github:laranex/a', '../a', '>=1.2.3']) {
            assert.equal(check({ a: spec }, { 'node_modules/a': registry('1.2.3') }), 1, spec);
        }
        assert.equal(check({ a: '1.2.3' }, {}), 1);
        assert.equal(check({ a: '1.2.3' }, { 'node_modules/a': registry('1.2.4') }), 1);
        assert.equal(check({ a: '1.2.3' }, { 'node_modules/a': { version: '1.2.3', resolved: 'file:vendor/a-1.2.3.tgz' } }), 1);
    });
});

describe('package', { timeout: 300_000 }, () => {
    test('the packed tarball installs and runs', async (t) => {
        const dir = tempDir(t);
        const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })) as {
            filename: string;
            files: { path: string }[];
        }[];
        const tarball = packed[0];
        assert.ok(tarball);
        const files = tarball.files.map((f) => f.path).sort();
        for (const required of ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'dist/mcp.js', 'dist/server.js', 'dist/compare.js', 'dist/check.js', 'dist/isolation/worker.js', 'dist/introspection/worker.js', 'dist/schema/serialize.js']) {
            assert.ok(files.includes(required), required);
        }
        assert.deepEqual(files.filter((f) => !/^(dist\/(isolation\/|introspection\/|schema\/)?[\w-]+\.(js|d\.ts)|LICENSE|NOTICE|README\.md|CHANGELOG\.md|package\.json)$/.test(f)), []);

        const project = join(dir, 'project');
        mkdirSync(project);
        writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'packaging-test', private: true }));
        execFileSync(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', join(dir, tarball.filename)], { cwd: project, stdio: ['ignore', 'ignore', 'inherit'] });
        const bin = join(project, 'node_modules', '.bin', 'node-schema-viewer');
        assert.ok(readdirSync(join(project, 'node_modules', 'node-schema-viewer', 'dist')).includes('cli.js'));

        assert.equal(execFileSync(bin, ['--version'], { cwd: project, encoding: 'utf8' }), '0.1.0\n');

        const child = spawn(bin, ['serve', '--snapshot', COMBINED, '--port', '0'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            const url = await new Promise<string>((resolve, reject) => {
                let stdout = '';
                child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
                    stdout += chunk;
                    const match = /(http:\/\/\S+)\n/.exec(stdout);
                    if (match?.[1]) resolve(match[1]);
                });
                child.on('close', (code) => {
                    reject(new Error(`serve exited with ${String(code)}`));
                });
            });
            const index = await fetch(`${url}/`);
            assert.equal(index.status, 200);
            assert.match(await index.text(), /schema-viewer/);
            assert.equal((await fetch(`${url}/app.js`)).status, 200);
            assert.equal(((await (await fetch(`${url}/snapshot.json`)).json()) as { source: string }).source, 'combined');
        } finally {
            child.kill('SIGTERM');
        }

        // compare and check from the installed layout, on a stored comparison.
        const tenants = join(VALID, 'comparison-tenant-schemas.json');
        const compared = spawnSync(bin, ['compare', '--snapshot', tenants, 'app:tenant_a=app:*', '--json'], { cwd: project, encoding: 'utf8' });
        assert.equal(compared.status, 0, compared.stderr);
        assert.equal((JSON.parse(compared.stdout) as unknown[]).length, 1);
        const checked = spawnSync(bin, ['check', '--snapshot', tenants, '--json'], { cwd: project, encoding: 'utf8' });
        assert.equal(checked.status, 1, checked.stderr);
        assert.equal((JSON.parse(checked.stdout) as { format: string }).format, 'laranex-schema-gate');

        // Introspection from the installed layout, where the drivers are hoisted into the project's node_modules and
        // the worker may read only their directories, never the project.
        const sqlite = sqliteDatabase(['sqlite.sql']);
        const postgres = adminUrl('postgres') === undefined ? null : await serverDatabase('postgres', ['drift-postgresql.sql']);
        try {
            const script =
                "import { introspect } from 'node-schema-viewer'; const urls = JSON.parse(process.argv[1]); const out = [];" +
                'for (const url of urls) { const d = await introspect({ url }); out.push(d.connections[0].driver + ":" + d.connections[0].tables.length); }' +
                'console.log(out.join(" "));';
            const urls = [sqlite.url, ...(postgres === null ? [] : [postgres.url('reader')])];
            const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(urls)], { cwd: project, encoding: 'utf8' });
            assert.equal(output.trim(), ['sqlite:3', ...(postgres === null ? [] : ['postgresql:6'])].join(' '));
        } finally {
            sqlite.drop();
            await postgres?.drop();
        }

        const client = new Client({ name: 'packaging-test', version: '0.0.0' });
        await client.connect(new StdioClientTransport({ command: bin, args: ['mcp', '--snapshot', COMBINED], cwd: project, stderr: 'ignore' }));
        try {
            const { tools } = await client.listTools();
            assert.equal(tools.length, 6);
            const result = await client.callTool({ name: 'schema_overview', arguments: { limit: 1 } });
            assert.notEqual(result.isError, true);
        } finally {
            await client.close();
        }
    });
});
