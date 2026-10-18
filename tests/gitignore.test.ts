// Snapshots kept out of Git: the .gitignore block `init` appends, and `build`'s check of its output path (tracked:
// fails before writing; inside a work tree and not ignored: a warning; ignored or outside Git: silent).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { addGitignoreBlock, GITIGNORE_BEGIN, GITIGNORE_END } from '../src/gitignore.js';
import { sqliteDatabase } from './databases.js';
import { CLI, runCli, tempDir } from './helpers.js';

const block = (...lines: string[]) => [GITIGNORE_BEGIN, ...lines, GITIGNORE_END].join('\n');

describe('init .gitignore block', () => {
    test('appends the default paths and a different configured output, anchored and escaped, once', (t) => {
        const dir = tempDir(t);
        assert.deepEqual(addGitignoreBlock(dir, 'schema-viewer.json').added, ['/schema-viewer.json', '/schema-viewer.html']);
        assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), `${block('/schema-viewer.json', '/schema-viewer.html')}\n`);
        assert.deepEqual(addGitignoreBlock(dir, 'other.json').added, []);

        const custom = tempDir(t);
        writeFileSync(join(custom, '.gitignore'), 'node_modules/\n/schema-viewer.html');
        const result = addGitignoreBlock(custom, './docs/[draft] *schema.json');
        assert.deepEqual(result.added, ['/schema-viewer.json', '/docs/\\[draft] \\*schema.json']);
        assert.equal(readFileSync(join(custom, '.gitignore'), 'utf8'), `node_modules/\n/schema-viewer.html\n\n${block('/schema-viewer.json', '/docs/\\[draft] \\*schema.json')}\n`);
    });

    test('keeps CRLF line endings, skips an output outside the project, adds nothing when every path is ignored', (t) => {
        const dir = tempDir(t);
        writeFileSync(join(dir, '.gitignore'), 'dist/\r\n');
        assert.deepEqual(addGitignoreBlock(dir, '../elsewhere/schema.json').added, ['/schema-viewer.json', '/schema-viewer.html']);
        assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), `dist/\r\n\r\n${block('/schema-viewer.json', '/schema-viewer.html').replace(/\n/g, '\r\n')}\r\n`);

        const done = tempDir(t);
        writeFileSync(join(done, '.gitignore'), '/schema-viewer.json\n/schema-viewer.html\n');
        assert.deepEqual(addGitignoreBlock(done, 'schema-viewer.json').added, []);
        assert.equal(readFileSync(join(done, '.gitignore'), 'utf8'), '/schema-viewer.json\n/schema-viewer.html\n');
    });

    test('init reports what it added', async (t) => {
        const dir = tempDir(t);
        writeFileSync(join(dir, 'package.json'), '{\n  "name": "app"\n}\n');
        const run = await runCli(['init', '--output', 'docs/schema.json'], { cwd: dir });
        assert.equal(run.code, 0, run.stderr);
        assert.match(run.stdout, /Added \/schema-viewer\.json, \/schema-viewer\.html, \/docs\/schema\.json to .*\.gitignore: schema snapshots must never be committed\.\n/);
        assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), `${block('/schema-viewer.json', '/schema-viewer.html', '/docs/schema.json')}\n`);
    });
});

describe('build output and Git', () => {
    function git(cwd: string, ...args: string[]): void {
        execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
    }

    function project(t: TestContext, repository: boolean): { dir: string; env: Record<string, string> } {
        const database = sqliteDatabase(['drizzle-sqlite.sql']);
        t.after(() => {
            database.drop();
        });
        const dir = realpathSync(tempDir(t));
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, 'node-schema-viewer': { databases: { local: { urlEnv: 'NSV_LOCAL_URL' } } } }));
        if (repository) {
            git(dir, 'init', '-q');
        }
        return { dir, env: { NSV_LOCAL_URL: database.url } };
    }

    function build(dir: string, env: Record<string, string>, output: string) {
        return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [CLI, 'build', '--source', 'database', '--output', output], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
            child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
            child.on('error', reject);
            child.on('close', (code) => {
                resolve({ code, stdout, stderr });
            });
        });
    }

    test('an output tracked in the index fails before anything is written', async (t) => {
        const { dir, env } = project(t, true);
        mkdirSync(join(dir, 'docs'));
        writeFileSync(join(dir, 'docs', 'schema.json'), '{}\n');
        git(dir, 'add', 'docs/schema.json');
        const run = await build(dir, env, 'docs/schema.json');
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.match(run.stderr, /^Error: docs\/schema\.json is tracked by Git: a schema snapshot must not be committed\. Untrack it with `git rm --cached docs\/schema\.json`/);
        assert.equal(readFileSync(join(dir, 'docs', 'schema.json'), 'utf8'), '{}\n');
    });

    test('an output in the work tree that Git does not ignore is written with a warning', async (t) => {
        const { dir, env } = project(t, true);
        const run = await build(dir, env, 'out/schema.json');
        assert.equal(run.code, 0, run.stderr);
        // node:sqlite may add an ExperimentalWarning on Node.js 22.
        assert.match(run.stderr, /^Warning: out\/schema\.json is inside a Git work tree and not ignored; add it to \.gitignore so the schema snapshot is never committed$/m);
        assert.ok(existsSync(join(dir, 'out', 'schema.json')));
    });

    test('an ignored output, or one outside a Git work tree, gets no warning', async (t) => {
        const ignored = project(t, true);
        writeFileSync(join(ignored.dir, '.gitignore'), '/schema-viewer.json\n');
        const quiet = await build(ignored.dir, ignored.env, 'schema-viewer.json');
        assert.equal(quiet.code, 0, quiet.stderr);
        assert.doesNotMatch(quiet.stderr, /Git/);
        const outside = project(t, false);
        const plain = await build(outside.dir, outside.env, 'schema-viewer.json');
        assert.equal(plain.code, 0, plain.stderr);
        assert.doesNotMatch(plain.stderr, /Git/);
    });
});
