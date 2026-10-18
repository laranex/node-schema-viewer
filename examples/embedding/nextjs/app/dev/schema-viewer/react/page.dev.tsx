// The React component in an application page at /dev/schema-viewer/react. The page checks the credentials on the
// server before rendering (the proxy already did); the browser then fetches the snapshot from the protected
// /dev/schema-viewer/snapshot.json, so the schema is never part of a JavaScript bundle.
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { devViewerConfig, isAuthorized, PREFIX } from '../../../../../lib/dev-auth.mjs';
import { SchemaViewerClient } from './schema-viewer-client.dev';

export const dynamic = 'force-dynamic';

export default async function SchemaViewerPage() {
    const viewer = devViewerConfig();
    if (!viewer.enabled || !isAuthorized((await headers()).get('authorization'), viewer)) {
        notFound();
    }
    return <SchemaViewerClient snapshotUrl={`${PREFIX}/snapshot.json`} />;
}
