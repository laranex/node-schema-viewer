export interface ViewerResponse {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}
export declare function createSchemaViewer(options: { snapshot: string; prefix: string; policy?: string }): (method: string, path: string) => ViewerResponse;
