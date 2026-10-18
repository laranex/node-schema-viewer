# Test image for the container isolation tests: Node.js 24, whose Permission Model does not restrict the network (so
# the tests show the container doing it), and this package installed from a locally packed tarball into /opt/lsv (not
# globally), the image's working directory, where the build resolves it. No application code and no credentials.
FROM node:24-slim
COPY *.tgz /tmp/
RUN mkdir /opt/lsv \
    && npm install --prefix /opt/lsv --no-audit --no-fund /tmp/node-schema-viewer-*.tgz \
    && rm /tmp/*.tgz
WORKDIR /opt/lsv
