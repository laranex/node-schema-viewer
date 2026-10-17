// Helpers for the hostile modules: every attempt is recorded as an outcome instead of failing the import.
export function code(error) {
    return error?.code ?? error?.cause?.code ?? error?.name ?? String(error);
}

export async function attempt(action) {
    try {
        return await action();
    } catch (error) {
        return `blocked ${code(error)}`;
    }
}
