/**
 * @file src/api/index.js
 * @description Public barrel for the AgentForge API module.
 *
 * Re-exports the two entry-point functions so callers can import from
 * `'./api/index.js'` (or `'./api'`) without caring about internal layout.
 *
 * @example
 * import { startServer, startWebSocketServer } from './api/index.js';
 */

export { startServer } from './server.js';
export { startWebSocketServer } from './ws.js';
