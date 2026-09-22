/* ==========================================
 * JEST STUB — "server-only"
 * ==========================================
 *
 * Next.js resolves the `server-only` marker
 * itself ("the contents of these packages from
 * NPM are not used by Next.js"), so the module
 * does not need to be installed as a dependency.
 *
 * Jest runs in plain Node, where the bare import
 * would be unresolvable, so jest.config.js maps
 * it to this empty module. Behaviour (build-time
 * error when a Client Component imports it) is
 * enforced by Next, not by this file.
 */

module.exports = {};
