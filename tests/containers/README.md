# Container isolation tests

`tests/isolation.test.ts` runs its container isolation tests only when `LSV_TEST_CONTAINER_IMAGE` names an image that
has this package, at the same version, resolvable from the image's working directory (the Dockerfile installs it into
`/opt/lsv` with `npm install --prefix`):

```bash
rm -rf /tmp/lsv-image && mkdir /tmp/lsv-image
npm pack --pack-destination /tmp/lsv-image
cp tests/containers/Dockerfile /tmp/lsv-image/
docker build -t lsv-node-test /tmp/lsv-image
LSV_TEST_CONTAINER_IMAGE=lsv-node-test npm test
```

`LSV_TEST_CONTAINER_RUNTIME=podman` runs them with Podman. The tests never pull: `node:24-slim` must be present
locally (the image build pulls it), and one test builds and removes a derived image with another package version. On macOS and Windows, Docker Desktop must share the project
directory and the system temporary directory. Rebuild the image after every change to `src/`: the worker inside the
container is the packed copy, not the working tree.
