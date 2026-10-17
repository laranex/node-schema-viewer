# Test image for the container isolation tests: Node.js 24, whose Permission Model does not restrict the network (so
# the tests show the container doing it), and this package installed globally from a locally packed tarball. No
# application code and no credentials.
FROM node:24-slim
COPY laranex-schema-viewer-*.tgz /tmp/
RUN npm install --global --no-audit --no-fund /tmp/laranex-schema-viewer-*.tgz && rm /tmp/laranex-schema-viewer-*.tgz
