/**
 * HTTP endpoint extraction (the gap static import analysis cannot close).
 *
 * Imports tie a project together, but nothing imports across a network boundary:
 * a mobile app calling POST /api/templates has no edge to the Express handler
 * that serves it, so renaming the route breaks a caller no dependency graph can
 * see. This scanner records both ends as text, and the matcher pairs them up.
 *
 * It is regex-based on purpose. Routes and calls are written in a dozen dialects
 * across Express, Nest, Flask, axios and fetch, and a partial answer on all of
 * them beats an exact answer on one. Anything ambiguous is left out rather than
 * guessed: a wrong link is worse than a missing one, because it invites a change
 * that breaks something.
 */

export type EndpointRole = "provides" | "consumes" | "mounts";

export interface ParsedEndpoint {
  role: EndpointRole;
  /** Upper-case verb, or null when the source does not say. */
  method: string | null;
  /** The path exactly as written, for display. */
  rawPath: string;
  /** Comparable form: params collapsed, host and query removed (see canonicalPath). */
  canonical: string;
  line: number;
  /** For "mounts", the identifier being mounted, e.g. "templatesRoutes". */
  mountedName: string | null;
  /** Which pattern matched, so a surprising result can be traced back. */
  source: string;
  /** A call to someone else's API. Never a contract with code in this workspace. */
  external: boolean;
}

const VERBS = "get|post|put|patch|delete|options|head|all";

/** Receivers that serve requests. `api` is deliberately absent - it is a client. */
const SERVER_RECEIVER = /^(?:app|server|[\w$]*router|routes?)$/i;
/** Receivers that make requests. */
const CLIENT_RECEIVER = /^(?:axios|api|apiclient|client|http|https|request|instance|agent|fetcher|[\w$]*api)$/i;

// \x60 is the backtick: these patterns must match template literals, so they are
// built from plain strings rather than template literals of their own.
const Q = "['\"\\x60]";
const NOT_Q = "[^'\"\\x60]";

// `api.post<ApiResponse<Tokens>>(...)` - the type argument sits between the verb
// and the call, and skipping it here is the difference between seeing a typed
// client's calls and seeing none of them. `[^()]*` cannot cross a parenthesis, so
// the greedy match can only end at the call's own opening bracket.
const CALL = new RegExp(
  "\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(" + VERBS + ")\\s*(?:<[^()]*>)?\\s*\\(\\s*(" + Q + ")(" + NOT_Q + "*)\\3",
  "gi",
);

const USE_MOUNT = new RegExp(
  "\\b(?:app|server|[\\w$]*[Rr]outer)\\s*\\.\\s*use\\s*\\(\\s*(" +
    Q +
    ")(" +
    NOT_Q +
    "*)\\1\\s*,\\s*([A-Za-z_$][\\w$]*)",
  "g",
);

const FETCH_CALL = new RegExp("\\bfetch\\s*\\(\\s*(" + Q + ")(" + NOT_Q + "*)\\1", "g");

/** Nest / TS decorators: @Get("x"), @Post(), @Controller("templates"). */
const DECORATOR = new RegExp(
  "@(Get|Post|Put|Patch|Delete|Options|Head|All)\\s*\\(\\s*(?:(" + Q + ")(" + NOT_Q + "*)\\2)?",
  "g",
);
const CONTROLLER = new RegExp("@Controller\\s*\\(\\s*(" + Q + ")(" + NOT_Q + "*)\\1", "g");

/** Python: @app.route("/x", methods=["POST"]) and @router.get("/x"). */
const PY_ROUTE = new RegExp("@\\w+\\.(route|" + VERBS + ")\\s*\\(\\s*(['\"])([^'\"]*)\\2([^)]*)", "gi");

/** A `method: "POST"` option near a fetch call, within the same call expression. */
const METHOD_OPTION = new RegExp("method\\s*:\\s*(" + Q + ")([A-Za-z]+)\\1");

/**
 * `baseURL: "https://graph.facebook.com/v21.0"` - a client pointed at somebody
 * else's service. Its calls are written as bare paths ("/me", "/${id}/messages")
 * and look exactly like calls to our own backend, so without this every Graph API
 * request is reported as a route we forgot to implement.
 *
 * A baseURL built from a variable or an environment value is left alone: that is
 * how a project addresses its own backend, and those calls are real contracts.
 */
const BASE_URL_LITERAL = new RegExp("base_?url\\s*[:=]\\s*(" + Q + ")([^'\"\\x60]*)\\1", "i");

/**
 * Follows a concatenated path to its end: `"/conversations/" + id + "/messages"`.
 *
 * Only the first quoted chunk is matched by the call pattern, and reporting that
 * chunk alone would claim the code calls `/conversations/` - a route that does
 * not exist, next to the real one that does. Non-literal pieces become `{}`,
 * which is exactly how a route parameter is written on the other side.
 */
function readConcatenatedPath(content: string, from: number, first: string): string {
  let path = first;
  let index = from;

  for (;;) {
    const rest = content.slice(index);
    const plus = /^\s*\+\s*/.exec(rest);
    if (!plus) return path;
    index += plus[0].length;

    const literal = new RegExp("^(" + Q + ")(" + NOT_Q + "*)\\1").exec(content.slice(index));
    if (literal) {
      path += literal[2] ?? "";
      index += literal[0].length;
      continue;
    }

    // An expression: consume it up to the next operator or argument boundary.
    const expression = /^[^,)+]+/.exec(content.slice(index));
    if (!expression) return path;
    path += "{}";
    index += expression[0].length;
  }
}

function hasExternalBaseUrl(content: string): boolean {
  const match = BASE_URL_LITERAL.exec(content);
  const value = match?.[2] ?? "";
  if (!/^[a-z]+:\/\//i.test(value)) return false;
  return !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(value);
}

/**
 * Reduces a path to something two codebases can be compared on.
 *
 * Parameters become `{}` because `:id`, `${id}` and `<int:id>` are the same slot.
 * A leading `api` or version segment is dropped, since it usually lives in the
 * client's baseURL on one side and in the mount prefix on the other - keeping it
 * would make every real pair look like a mismatch.
 */
export function canonicalPath(path: string): string {
  let value = path.trim();

  value = value.replace(/^[a-z]+:\/\/[^/]+/i, ""); // scheme + host
  value = value.replace(/[?#].*$/, ""); // query and fragment
  value = value.replace(/\$\{[^}]*\}/g, "{}"); // ${id}
  value = value.replace(/<[^>]*>/g, "{}"); // Flask <int:id>
  value = value.replace(/\{[^}]*\}/g, "{}"); // {id}
  value = value.replace(/:[A-Za-z_$][\w$]*/g, "{}"); // Express :id
  value = value.replace(/\*+/g, "{}"); // wildcards
  // `/media/${id}${query}` produced "{}{}", which matched no route. Two adjacent
  // placeholders are still one path segment.
  value = value.replace(/(?:\{\})+/g, "{}");
  value = value.toLowerCase().replace(/\/{2,}/g, "/");
  value = value.replace(/^\/+|\/+$/g, "");

  const segments = value.split("/").filter((segment) => segment.length > 0);
  while (segments.length > 0 && /^(api|v\d+)$/.test(segments[0] as string)) segments.shift();

  return segments.join("/");
}

/** Joins a mount prefix to a route path in canonical space. */
export function joinCanonical(prefix: string, path: string): string {
  const joined = [prefix, path].filter((part) => part.length > 0).join("/");
  return canonicalPath(joined);
}

/**
 * Extracts every endpoint mentioned in one file. Whether a `.get()` call serves a
 * request or makes one is decided by the receiver: `router.get` is a route,
 * `api.get` is a call. Anything else is skipped, because a guess here produces a
 * link between two unrelated things.
 */
export function scanEndpoints(content: string, relativePath: string): ParsedEndpoint[] {
  const found: ParsedEndpoint[] = [];
  const lineAt = lineIndexer(content);
  const externalClient = hasExternalBaseUrl(content);

  for (const match of content.matchAll(USE_MOUNT)) {
    const prefix = match[2] ?? "";
    const name = match[3] ?? "";
    if (!prefix.startsWith("/")) continue; // app.use(cors) and friends
    found.push({
      role: "mounts",
      method: null,
      rawPath: prefix,
      canonical: canonicalPath(prefix),
      line: lineAt(match.index ?? 0),
      mountedName: name,
      source: "express_use",
      external: false,
    });
  }

  for (const match of content.matchAll(CALL)) {
    const receiver = match[1] ?? "";
    const verb = (match[2] ?? "").toUpperCase();
    const literal = match[4] ?? "";
    // A verb with no path is not an endpoint, and `.get(key)` on a Map is not either.
    if (!literal.startsWith("/") && !literal.startsWith("http")) continue;

    const path = readConcatenatedPath(content, (match.index ?? 0) + match[0].length, literal);

    const isServer = SERVER_RECEIVER.test(receiver);
    const isClient = CLIENT_RECEIVER.test(receiver);
    if (isServer === isClient) continue; // unknown, or a name that reads as both

    found.push({
      role: isServer ? "provides" : "consumes",
      method: verb === "ALL" ? null : verb,
      rawPath: path,
      canonical: canonicalPath(path),
      line: lineAt(match.index ?? 0),
      mountedName: null,
      source: isServer ? "express_route" : "http_client",
      external: !isServer && (externalClient || /^[a-z]+:\/\//i.test(path)),
    });
  }

  for (const match of content.matchAll(FETCH_CALL)) {
    const path = match[2] ?? "";
    if (!path.startsWith("/") && !path.startsWith("http")) continue;
    const tail = content.slice(match.index ?? 0, (match.index ?? 0) + 240);
    const method = METHOD_OPTION.exec(tail)?.[2]?.toUpperCase() ?? "GET";
    found.push({
      role: "consumes",
      method,
      rawPath: path,
      canonical: canonicalPath(path),
      line: lineAt(match.index ?? 0),
      mountedName: null,
      source: "fetch",
      external: externalClient || /^[a-z]+:\/\//i.test(path),
    });
  }

  const controllerPrefix = CONTROLLER.exec(content)?.[2] ?? "";
  CONTROLLER.lastIndex = 0;
  for (const match of content.matchAll(DECORATOR)) {
    const verb = (match[1] ?? "").toUpperCase();
    const path = match[3] ?? "";
    const combined = [controllerPrefix, path].filter(Boolean).join("/").replace(/^\/+/, "");
    found.push({
      role: "provides",
      method: verb === "ALL" ? null : verb,
      rawPath: `/${combined}`,
      canonical: canonicalPath(combined),
      line: lineAt(match.index ?? 0),
      mountedName: null,
      source: "nest_decorator",
      external: false,
    });
  }

  if (/\.py$/i.test(relativePath)) {
    for (const match of content.matchAll(PY_ROUTE)) {
      const verb = (match[1] ?? "").toUpperCase();
      const path = match[3] ?? "";
      if (!path.startsWith("/")) continue;
      const methods = /methods\s*=\s*\[([^\]]*)\]/i.exec(match[4] ?? "")?.[1];
      const method =
        verb === "ROUTE" ? (methods ? (/([A-Z]+)/.exec(methods.toUpperCase())?.[1] ?? null) : "GET") : verb;
      found.push({
        role: "provides",
        method,
        rawPath: path,
        canonical: canonicalPath(path),
        line: lineAt(match.index ?? 0),
        mountedName: null,
        source: "python_route",
        external: false,
      });
    }
  }

  return dedupe(found);
}

function dedupe(endpoints: ParsedEndpoint[]): ParsedEndpoint[] {
  const seen = new Set<string>();
  const unique: ParsedEndpoint[] = [];
  for (const endpoint of endpoints) {
    const key = `${endpoint.role}|${endpoint.method}|${endpoint.canonical}|${endpoint.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(endpoint);
  }
  return unique;
}

/** Character offset -> 1-based line, computed once per file rather than per match. */
function lineIndexer(content: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
