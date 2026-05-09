// Stub for the upstream plugins registry. Upstream's hooks middleware looks up
// plugin functions at runtime; with `plugins_enabled: []` in conf.json no plugin
// is ever invoked, so an empty registry is safe. Restore the upstream plugins/
// build pipeline if guardrails are ever enabled.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const plugins: Record<string, Record<string, (...args: any[]) => any>> = {};
