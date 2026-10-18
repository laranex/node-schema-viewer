'use client';

import { useEffect, useState } from 'react';
import { SchemaViewer, validateDocument, type SchemaDocument } from 'laranex-schema-viewer-ui';
import 'laranex-schema-viewer-ui/styles.css';

type State = { document: SchemaDocument } | { error: string } | null;

export function SchemaViewerClient({ snapshotUrl }: { snapshotUrl: string }) {
    const [state, setState] = useState<State>(null);

    useEffect(() => {
        let active = true;
        fetch(snapshotUrl, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`The snapshot request failed (${response.status}).`))))
            .then((data: unknown) => {
                const result = validateDocument(data);
                if (active) {
                    setState(result.ok ? { document: result.document } : { error: result.errors.join('\n') });
                }
            })
            .catch((error: unknown) => {
                if (active) {
                    setState({ error: error instanceof Error ? error.message : String(error) });
                }
            });
        return () => {
            active = false;
        };
    }, [snapshotUrl]);

    if (state === null) {
        return <p>Loading the schema…</p>;
    }
    if ('error' in state) {
        return <pre>{state.error}</pre>;
    }
    return (
        <div style={{ height: '100dvh' }}>
            <SchemaViewer document={state.document} downloadHref={snapshotUrl} />
        </div>
    );
}
