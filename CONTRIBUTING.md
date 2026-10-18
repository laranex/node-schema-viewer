# Contributing

Thank you for helping with `node-schema-viewer`. [AGENTS.md](AGENTS.md) describes the architecture, the conventions and
the security rules that every change must keep; read it before changing code.

## Set up and validate

Node.js 22.13 or later. From the repository root:

```bash
npm ci
npm run lint
npm run typecheck
npm test               # builds, then runs the whole suite, including the packaging test
npm run test:examples  # the embedding examples, over HTTP
```

Run the suite on another Node.js version with `PATH=/path/to/node/bin:$PATH npm test`. Process isolation is tested only
on Node.js 26; on 22 and 24 the tests check that it is refused.

- **Databases:** the database tests run only when `LSV_TEST_POSTGRES_URL`, `LSV_TEST_MYSQL_URL` and
  `LSV_TEST_MARIADB_URL` name disposable servers (`tests/databases/compose.yaml`). Never point them at a database
  that holds real data.
- **Container isolation:** the container tests run only when `LSV_TEST_CONTAINER_IMAGE` names a local image with this
  package at the same version; build it from the packed checkout as
  [tests/containers/README.md](tests/containers/README.md) describes, and rebuild it after every change to `src/`.
  The tests never pull images.
- **Documentation:** every `docs/*.md` is a page of the site in `.gh-page/`; add new pages to its sidebar
  (`.gh-page/.vitepress/config.mts`) and check the site with `cd .gh-page && npm ci && npm run check`.

Record user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Fixtures and schema snapshots

- **Fixtures must be synthetic.** Never commit a schema snapshot, an export or a gate report of a real application,
  credentials, database URLs or `.env` files, not even in a test.
- **A new or changed synthetic document needs a regenerated allowlist entry.** Add its path or directory to the
  explicit list in `scripts/allowlist.mjs` (never whatever a scan detects), regenerate the allowlist, and include the
  `.laranex-schema-allowlist.json` change in your pull request for review, with the reason in the commit message:

  ```bash
  node scripts/allowlist.mjs          # rewrites .laranex-schema-allowlist.json
  node scripts/allowlist.mjs --check  # exits 1 when the committed file is not current
  ```

  An allowlist entry is an explicit review decision, not proof that the content is harmless. `tests/scan.test.ts`
  checks that the allowlist is current and that the repository tracks no other document.
- **Scan before committing:**

  ```bash
  npm run build
  node dist/cli.js scan --tracked --untracked
  ```

  It must exit 0. Every other exit fails CI: 1 confirmed, 2 failed or incomplete, 3 uncertain. CI also scans the
  unpacked `npm pack` output (no document allowed) and the built documentation site. See
  [docs/cli.md](docs/cli.md#scan).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, …), one
logical change per commit.

## Security issues

Do not report vulnerabilities in public issues or pull requests. Follow [SECURITY.md](SECURITY.md).
