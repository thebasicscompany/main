// Logger output for the mounted gateway. Reverted to upstream's `console`
// (was: pino shim) because the project-references rootDir on this subtree
// can't import from sibling `../../middleware/logger.js`. To re-enable a
// pino shim later, expose pino via a small `.d.ts` ambient module that the
// gateway can import without crossing rootDir.
export const logger = console;
