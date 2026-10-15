/**
 * The walkthrough's slug — a stable, filesystem- and URL-safe identity derived
 * from its title. Deterministic on purpose: the same title always slugs the
 * same, so a consumer can use (namespace, slug) as a replace-on-repush key.
 */
export declare function slugify(s: string): string;
