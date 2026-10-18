import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

// The viewer's routes are *.dev.ts(x) files. They are routes only in `next dev` with SCHEMA_VIEWER_ENABLED=1; every
// other phase, `next build` included, does not treat them as routes, so the production build has no viewer page, no
// viewer route handler and no viewer code.
export default function config(phase) {
    const devViewer = phase === PHASE_DEVELOPMENT_SERVER && process.env.SCHEMA_VIEWER_ENABLED === '1';
    return {
        pageExtensions: devViewer ? ['dev.tsx', 'dev.ts', 'tsx', 'ts'] : ['tsx', 'ts'],
        // node-schema-viewer reads the viewer files beside its own module at run time; let Node.js load it unbundled.
        serverExternalPackages: ['node-schema-viewer'],
        poweredByHeader: false,
        agentRules: false,
    };
}
