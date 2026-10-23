/**
 * The walkthrough's slug — a stable, filesystem- and URL-safe identity derived
 * from its title. Deterministic on purpose: the same title always slugs the
 * same, so a consumer can use (namespace, slug) as a replace-on-repush key.
 */
export function slugify(s) {
    return (s
        .toLowerCase()
        .normalize('NFKD')
        // Strip combining marks so "café" slugs as "cafe", not "caf".
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'walkthrough');
}
