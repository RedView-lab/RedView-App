interface ProjectRouteTarget {
  id: string;
  name: string;
}

const PROJECT_ROUTE_PREFIX = '/project/';

function normaliseProjectSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function buildProjectPath(project: ProjectRouteTarget): string {
  const slug = normaliseProjectSlug(project.name);
  return slug
    ? `${PROJECT_ROUTE_PREFIX}${slug}--${encodeURIComponent(project.id)}`
    : `${PROJECT_ROUTE_PREFIX}${encodeURIComponent(project.id)}`;
}

export function readProjectIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(PROJECT_ROUTE_PREFIX)) return null;

  const rawSegment = pathname.slice(PROJECT_ROUTE_PREFIX.length).split('/')[0]?.trim();
  if (!rawSegment) return null;

  const separatorIndex = rawSegment.lastIndexOf('--');
  const encodedId = separatorIndex >= 0
    ? rawSegment.slice(separatorIndex + 2)
    : rawSegment;

  if (!encodedId) return null;

  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

export function replaceProjectLocation(project: ProjectRouteTarget | null): void {
  const nextPath = project ? buildProjectPath(project) : '/';
  if (window.location.pathname === nextPath) return;
  window.history.replaceState(null, '', nextPath);
}
