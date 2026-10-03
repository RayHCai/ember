/** The sim's one place that writes to the developer console (warnings worth seeing in devtools). */
export function warn(message: string, detail?: unknown): void {
    // oxlint-disable-next-line no-console
    console.warn(`[ember-drone-sim] ${message}`, ...(detail === undefined ? [] : [detail]));
}
