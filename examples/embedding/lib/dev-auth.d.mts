export declare const PREFIX: '/dev/schema-viewer';
export type DevViewerConfig = { enabled: false } | { enabled: true; user: string; password: string; snapshot: string };
export declare function devViewerConfig(env?: Record<string, string | undefined>): DevViewerConfig;
export declare function isAuthorized(header: string | null | undefined, credentials: { user: string; password: string }): boolean;
export declare const UNAUTHORIZED: { status: 401; headers: Record<string, string>; body: string };
