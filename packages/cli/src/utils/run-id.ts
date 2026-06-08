// Guards against path traversal in run ids — reject anything outside [a-zA-Z0-9_-].
export const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;
// Guards against path traversal in node ids — reject anything outside [a-zA-Z0-9_-].
export const NODE_ID_RE = /^[a-zA-Z0-9_-]+$/;
