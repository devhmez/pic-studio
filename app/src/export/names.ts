// File names of the exports.

/**
 * ASCII file base name from the project name (« TP — Manipulation du registre STATUS » →
 * « tp-manipulation-du-registre-status »): safe for MikroC, ISIS and Windows paths.
 */
export function fileBase(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'projet';
}
