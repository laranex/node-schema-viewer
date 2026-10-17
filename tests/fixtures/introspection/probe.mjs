// Stands in for the introspection worker under the exact flags the runner builds: tries to read a project file and
// to import a module from the project, and records what happened in the result file.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const result = process.argv[process.argv.indexOf('--result') + 1];
const { file, module } = JSON.parse(readFileSync(0, 'utf8'));
const outcome = {};
try {
    readFileSync(file, 'utf8');
    outcome.read = 'read';
} catch (error) {
    outcome.read = error.code;
}
try {
    await import(pathToFileURL(module).href);
    outcome.import = 'imported';
} catch (error) {
    outcome.import = error.code;
}
try {
    await import('pg');
    outcome.pg = 'ok';
} catch (error) {
    outcome.pg = error.code ?? error.message;
}
outcome.cwd = process.cwd();
outcome.argv = process.argv;
outcome.env = process.env;
writeFileSync(result, JSON.stringify(outcome));
