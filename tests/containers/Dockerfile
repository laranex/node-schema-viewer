# Test image for the container isolation tests: Node.js 24, whose Permission Model does not restrict the network (so
# the tests show the container doing it), and this package installed from a locally packed tarball into /opt/lsv (not
# globally), the image's working directory, where the build resolves it. No application code and no credentials.
# While laranex-schema-viewer-ui is vendored (vendor/*.tgz, see CHANGELOG), its tarball is copied in too and the
# install overrides the dependency with it, because an installed copy cannot resolve the file: dependency itself.
FROM node:24-slim
COPY *.tgz /tmp/
RUN mkdir /opt/lsv \
    && for ui in /tmp/laranex-schema-viewer-ui-*.tgz; do \
        if [ -e "$ui" ]; then printf '{"private":true,"overrides":{"laranex-schema-viewer-ui":"file:%s"}}\n' "$ui" > /opt/lsv/package.json; fi; \
    done \
    && npm install --prefix /opt/lsv --no-audit --no-fund /tmp/node-schema-viewer-*.tgz \
    && rm /tmp/*.tgz
WORKDIR /opt/lsv
