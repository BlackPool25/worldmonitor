import docsConfigJson from '../../docs/docs.json';

const DOCS_ORIGIN = 'https://www.worldmonitor.app';

type DocsConfigLike = {
  navigation?: unknown;
  redirects?: Array<{ source: string; destination: string }>;
};

const VERCEL_OWNED_DOC_PATHS = new Set([
  '/about',
  '/changelog',
  '/contact',
  '/pricing',
  '/privacy',
  '/support',
  '/terms',
]);

function normalizePath(path: string): string {
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}

function addNavigationPages(node: unknown, routes: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) addNavigationPages(entry, routes);
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'pages' && Array.isArray(value)) {
      for (const page of value) {
        if (typeof page === 'string') {
          const path = normalizePath(page);
          routes.set(path, `${DOCS_ORIGIN}/docs${path}`);
        } else {
          addNavigationPages(page, routes);
        }
      }
      continue;
    }
    addNavigationPages(value, routes);
  }
}

export function buildRootlessDocsRedirects(config: DocsConfigLike): Map<string, string> {
  const routes = new Map<string, string>();
  addNavigationPages(config.navigation, routes);

  for (const redirect of config.redirects ?? []) {
    const source = normalizePath(redirect.source);
    const destination = normalizePath(redirect.destination);
    routes.set(source, `${DOCS_ORIGIN}/docs${destination}`);
  }

  return routes;
}

export const ROOTLESS_DOC_REDIRECTS = buildRootlessDocsRedirects(
  docsConfigJson as DocsConfigLike
);

export function getRootlessDocsDestination(pathname: string): string | null {
  const path = normalizePath(pathname);
  if (VERCEL_OWNED_DOC_PATHS.has(path)) return null;
  return ROOTLESS_DOC_REDIRECTS.get(path) ?? null;
}
