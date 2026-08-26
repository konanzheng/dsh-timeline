/**
 * dsh-history — host-side (node) plugin entry.
 *
 * Deliberately empty: the S-shaped trajectory timeline is a browser-only
 * capability. Keeping a host `apply()` here means the same package can be
 * composed in a `cordis.yml` (or a profile) without the harness complaining
 * about a plugin with no node body. All behaviour lives in the `./client`
 * browser half, which the DSH web shell mounts as a `dsh.client` module.
 */
export function apply(): void {}
