// Packs the package, installs the tarball into an empty project and runs the installed binary.
// Needs the npm registry (or a warm npm cache) for the dependencies.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { COMBINED, ROOT, tempDir } from './helpers.js';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
        for (const required of ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'dist/mcp.js', 'dist/server.js', 'dist/isolation/worker.js']) {
            assert.ok(files.includes(required), required);
        }
        assert.deepEqual(files.filter((f) => !/^(dist\/(isolation\/)?[\w-]+\.(js|d\.ts)|LICENSE|NOTICE|README\.md|CHANGELOG\.md|package\.json)$/.test(f)), []);

        const project = join(dir, 'project');
        mkdirSync(project);
        writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'packaging-test', private: true }));
        execFileSync(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', join(dir, tarball.filename)], { cwd: project, stdio: ['ignore', 'ignore', 'inherit'] });
        const bin = join(project, 'node_modules', '.bin', 'laranex-schema-viewer');
        assert.ok(readdirSync(join(project, 'node_modules', 'laranex-schema-viewer', 'dist')).includes('cli.js'));

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

        const client = new Client({ name: 'packaging-test', version: '0.0.0' });
        await client.connect(new StdioClientTransport({ command: bin, args: ['mcp', '--snapshot', COMBINED], cwd: project, stderr: 'ignore' }));
        try {
            const { tools } = await client.listTools();
            assert.equal(tools.length, 5);
            const result = await client.callTool({ name: 'schema_overview', arguments: { limit: 1 } });
            assert.notEqual(result.isError, true);
        } finally {
            await client.close();
        }
    });
});
