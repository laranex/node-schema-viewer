# Container isolation tests

`tests/isolation.test.ts` runs its container isolation tests only when `LSV_TEST_CONTAINER_IMAGE` names an image that
has this package, at the same version, installed globally:

```bash
rm -rf /tmp/lsv-image && mkdir /tmp/lsv-image
npm pack --pack-destination /tmp/lsv-image
cp tests/containers/Dockerfile /tmp/lsv-image/
docker build -t lsv-test /tmp/lsv-image
LSV_TEST_CONTAINER_IMAGE=lsv-test npm test
```

`LSV_TEST_CONTAINER_RUNTIME=podman` runs them with Podman. On macOS and Windows, Docker Desktop must share the project
directory and the system temporary directory. Rebuild the image after every change to `src/`: the worker inside the
container is the packed copy, not the working tree.
