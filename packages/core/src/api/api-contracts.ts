import type { EndpointRecord, EndpointStore } from "@samirthakur024/indexer";

export interface EndpointSite {
  project: string;
  path: string;
  line: number;
  rawPath: string;
}

export interface ApiLink {
  method: string | null;
  /** Comparable path, params collapsed: "campaigns/{}/failed/export". */
  canonical: string;
  providers: EndpointSite[];
  consumers: EndpointSite[];
}

export interface ApiContractReport {
  scope: string;
  /** Calls that reach a route: changing either side affects the other. */
  linked: ApiLink[];
  /** Calls with no route anywhere in scope - a rename, a typo, or a gap. */
  unmatchedCalls: ApiLink[];
  /** Routes nobody in scope calls. Informational: the caller may be elsewhere. */
  unusedRoutes: ApiLink[];
  /** Calls to absolute URLs on other hosts, which say nothing about this code. */
  externalCalls: number;
  totals: { providers: number; consumers: number; linked: number; unmatched: number; unused: number };
}

export interface ProjectEndpoints {
  project: string;
  endpoints: EndpointStore;
  projectId: string;
}

/**
 * Pairs HTTP calls with the routes that serve them (PRD 17's missing edge).
 *
 * Import analysis stops at the process boundary, so a mobile app and the backend
 * it talks to look like unrelated codebases. Comparing canonical paths puts the
 * edge back: rename a route and the calls that will break are named, before the
 * change ships rather than after a user hits it.
 *
 * Method matching is deliberately forgiving - a route registered without a verb,
 * or a call whose verb could not be read, still matches on path. The alternative
 * is to miss real pairs, which costs more than an occasional loose one.
 */
export function buildApiContracts(scope: string, sources: ProjectEndpoints[]): ApiContractReport {
  const providers: Array<EndpointSite & { record: EndpointRecord }> = [];
  const consumers: Array<EndpointSite & { record: EndpointRecord }> = [];
  let externalCalls = 0;

  for (const source of sources) {
    for (const record of source.endpoints.provides(source.projectId)) {
      providers.push({ project: source.project, path: record.path, line: record.line, rawPath: record.rawPath, record });
    }
    for (const record of source.endpoints.consumes(source.projectId)) {
      // A call to https://graph.facebook.com is an integration, not a contract
      // with anything in this workspace; counting it as unmatched would bury the
      // calls that genuinely have no route.
      if (record.external) {
        externalCalls += 1;
        continue;
      }
      consumers.push({ project: source.project, path: record.path, line: record.line, rawPath: record.rawPath, record });
    }
  }

  const links = new Map<string, ApiLink>();
  const keyOf = (method: string | null, canonical: string): string => `${method ?? "*"} ${canonical}`;

  const linkFor = (method: string | null, canonical: string): ApiLink => {
    const key = keyOf(method, canonical);
    let link = links.get(key);
    if (!link) {
      link = { method, canonical, providers: [], consumers: [] };
      links.set(key, link);
    }
    return link;
  };

  for (const provider of providers) {
    linkFor(provider.record.method, provider.record.canonical).providers.push(strip(provider));
  }

  for (const consumer of consumers) {
    const canonical = consumer.record.canonical;
    const method = consumer.record.method;

    // Exact verb first, then a verb-less route on the same path.
    const exact = links.get(keyOf(method, canonical));
    const wildcard = links.get(keyOf(null, canonical));
    const target = exact?.providers.length ? exact : (wildcard?.providers.length ? wildcard : null);

    if (target) {
      target.consumers.push(strip(consumer));
      continue;
    }
    linkFor(method, canonical).consumers.push(strip(consumer));
  }

  const all = [...links.values()];
  const linked = all.filter((link) => link.providers.length > 0 && link.consumers.length > 0);
  const unmatchedCalls = all.filter((link) => link.providers.length === 0 && link.consumers.length > 0);
  const unusedRoutes = all.filter((link) => link.providers.length > 0 && link.consumers.length === 0);

  const byPath = (a: ApiLink, b: ApiLink): number => a.canonical.localeCompare(b.canonical);

  return {
    scope,
    linked: linked.sort(byPath),
    unmatchedCalls: unmatchedCalls.sort(byPath),
    unusedRoutes: unusedRoutes.sort(byPath),
    externalCalls,
    totals: {
      providers: providers.length,
      consumers: consumers.length,
      linked: linked.length,
      unmatched: unmatchedCalls.length,
      unused: unusedRoutes.length,
    },
  };
}

/**
 * The callers a route change would break, for one path.
 *
 * This is the question worth asking before editing a handler: who else has to
 * change with me, in repositories I am not currently looking at?
 */
export function callersOf(report: ApiContractReport, canonical: string): EndpointSite[] {
  const target = canonicalise(canonical);
  return report.linked
    .filter((link) => link.canonical === target)
    .flatMap((link) => link.consumers);
}

function canonicalise(value: string): string {
  return value.replace(/^\/+|\/+$/g, "").toLowerCase();
}

function strip(site: EndpointSite & { record: EndpointRecord }): EndpointSite {
  return { project: site.project, path: site.path, line: site.line, rawPath: site.rawPath };
}
