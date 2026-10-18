// Keeps schema snapshots out of Git: `init` appends an ignore block to the project's .gitignore, and `build` checks its
// output path against the Git index and ignore rules before writing. Git runs with a fixed argv, never a shell.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const GITIGNORE_BEGIN = '# >>> node-schema-viewer: schema snapshots are sensitive, never commit them >>>';
export const GITIGNORE_END = '# <<< node-schema-viewer <<<';
const DEFAULT_IGNORED = ['schema-viewer.json', 'schema-viewer.html'];

// A project-relative POSIX path as an anchored .gitignore pattern, its special characters escaped.
function pattern(path: string): string {
    return `/${path.replace(/[\\*?[]/g, '\\$&').replace(/^([!#])/, '\\$1').replace(/ $/, '\\ ')}`;
}

// Appends the block (once) with the default snapshot and HTML export paths and the configured output when it differs
// and lies inside the project. Returns the patterns added, none when the block is already there or every pattern is.
export function addGitignoreBlock(projectRoot: string, output: string): { path: string; added: string[] } {
    const root = resolve(projectRoot);
    const path = join(root, '.gitignore');
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (text.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_BEGIN)) {
        return { path, added: [] };
    }
    const paths = [...DEFAULT_IGNORED];
    const inside = relative(root, resolve(root, output));
    if (inside && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)) {
        paths.push(inside.split(sep).join('/'));
    }
    const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
    const added = [...new Set(paths.map(pattern))].filter((p) => !present.has(p));
    if (added.length === 0) {
        return { path, added };
    }
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lead = text === '' ? '' : text.endsWith('\n') ? newline : newline + newline;
    writeFileSync(path, text + lead + [GITIGNORE_BEGIN, ...added, GITIGNORE_END].join(newline) + newline);
    return { path, added };
}

export class TrackedOutputError extends Error {}

function git(cwd: string, args: string[]): { status: number | null; stdout: string } {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: result.error ? null : result.status, stdout: result.error ? '' : result.stdout };
}

// Before `build` writes: an output path tracked in the Git index fails (nothing is written); one inside a work tree
// that Git does not ignore gets a warning. Outside a Git work tree, or without Git, there is nothing to check.
export function checkOutputPath(output: string, warn: (line: string) => void): void {
    const absolute = resolve(output);
    let directory = dirname(absolute);
    while (!existsSync(directory) && dirname(directory) !== directory) {
        directory = dirname(directory);
    }
    const top = git(directory, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) {
        return;
    }
    const root = realpathSync(top.stdout.trim());
    const real = join(realpathSync(directory), relative(directory, dirname(absolute)), basename(absolute));
    const path = relative(root, real).split(sep).join('/');
    if (path === '' || path.startsWith('../') || isAbsolute(path)) {
        return;
    }
    const shown = relative(process.cwd(), absolute) || absolute;
    const tracked = git(root, ['--literal-pathspecs', 'ls-files', '-z', '--', path]);
    if (tracked.status !== 0) {
        throw new TrackedOutputError(`Could not check whether ${shown} is tracked by Git; nothing was written`);
    }
    if (tracked.stdout !== '') {
        throw new TrackedOutputError(
            `${shown} is tracked by Git: a schema snapshot must not be committed. Untrack it with \`git rm --cached ${shown}\`, ` +
                'ignore it in .gitignore, then build again',
        );
    }
    if (git(root, ['check-ignore', '-q', '--', path]).status !== 0) {
        warn(`Warning: ${shown} is inside a Git work tree and not ignored; add it to .gitignore so the schema snapshot is never committed`);
    }
}
