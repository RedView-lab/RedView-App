import axe from 'axe-core';

/**
 * Audit axe sous Vitest (happy-dom), avec les règles WCAG A/AA d'e2e:journey
 * (script-test-bench/user-journey/a11y.ts), pour les écrans que le parcours
 * n'ouvre pas. Sans mise en page, le contraste n'est pas calculable : il reste
 * vérifié par le parcours dans un vrai navigateur.
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** Violations « règle : cibles », vide si l'élément passe. */
export async function axeViolations(root: Element): Promise<string[]> {
  const result = await axe.run(root, {
    runOnly: { type: 'tag', values: WCAG_TAGS },
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}
