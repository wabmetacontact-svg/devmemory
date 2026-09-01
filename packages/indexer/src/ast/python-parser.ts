import crypto from "node:crypto";
import type { Node } from "web-tree-sitter";
import { parserFor } from "./tree-sitter-loader.js";
import {
  emptyParseResult,
  type LanguageParser,
  type ParsedReference,
  type ParsedSymbol,
  type ParseInput,
  type ParseResult,
  type SymbolType,
} from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "route"]);

function children(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

function collapse(text: string, limit = 240): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}...` : single;
}

function hashOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface WalkContext {
  symbols: ParsedSymbol[];
  imports: ParseResult["imports"];
  references: ParsedReference[];
}

class PythonParser implements LanguageParser {
  readonly name = "python";
  readonly languages = ["python"] as const;
  readonly grammars = ["python"] as const;

  parse(input: ParseInput): ParseResult {
    const tree = parserFor("python").parse(input.content);
    const result = emptyParseResult(input.language);
    if (!tree?.rootNode) return result;

    result.hasErrors = tree.rootNode.hasError;
    const context: WalkContext = { symbols: result.symbols, imports: result.imports, references: result.references };
    for (const child of children(tree.rootNode)) walk(child, context, null, null);
    tree.delete();
    return result;
  }
}

function addSymbol(
  context: WalkContext,
  node: Node,
  name: string,
  type: SymbolType,
  parentIndex: number | null,
  qualifiedPrefix: string | null,
  signature?: string,
): number {
  context.symbols.push({
    name,
    qualifiedName: qualifiedPrefix ? `${qualifiedPrefix}.${name}` : name,
    type,
    signature: signature ?? signatureFor(node),
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    // Python has no export keyword: a leading underscore is the convention for private.
    exported: !name.startsWith("_"),
    parentIndex,
    hash: hashOf(node.text),
  });
  return context.symbols.length - 1;
}

function signatureFor(node: Node): string {
  const body = field(node, "body");
  const end = body ? body.startIndex : node.endIndex;
  return collapse(node.text.slice(0, Math.max(0, end - node.startIndex)));
}

function addReference(context: WalkContext, name: string, kind: ParsedReference["kind"], node: Node, from: number | null): void {
  if (!name || name.length > 200) return;
  context.references.push({ name, kind, line: node.startPosition.row + 1, fromSymbolIndex: from });
}

function walk(node: Node, context: WalkContext, parentSymbol: number | null, className: string | null): void {
  switch (node.type) {
    case "import_statement": {
      for (const child of children(node)) {
        const specifier = child.type === "aliased_import" ? field(child, "name")?.text : child.text;
        if (specifier) {
          context.imports.push({ specifier, kind: "static", line: node.startPosition.row + 1, names: [] });
        }
      }
      return;
    }

    case "import_from_statement": {
      const moduleName = field(node, "module_name");
      if (moduleName) {
        const names = children(node)
          .filter((child) => child !== moduleName && (child.type === "dotted_name" || child.type === "identifier" || child.type === "aliased_import"))
          .map((child) => (child.type === "aliased_import" ? (field(child, "alias")?.text ?? child.text) : child.text));
        context.imports.push({
          specifier: moduleName.text,
          kind: "static",
          line: node.startPosition.row + 1,
          names,
        });
      }
      return;
    }

    case "decorated_definition": {
      const definition = children(node).find(
        (child) => child.type === "function_definition" || child.type === "class_definition",
      );
      const decorators = children(node).filter((child) => child.type === "decorator");
      const routeName = routeFromDecorators(decorators);

      if (definition) walk(definition, context, parentSymbol, className);
      const symbolIndex = context.symbols.length - 1;

      for (const decorator of decorators) {
        addReference(context, lastIdentifier(decorator.text.replace(/^@/, "")), "decorator", decorator, symbolIndex);
      }
      if (routeName) {
        addSymbol(context, node, routeName, "route", parentSymbol, null, collapse(decorators[0]?.text ?? routeName, 160));
      }
      return;
    }

    case "function_definition": {
      const name = field(node, "name")?.text;
      if (!name) return;
      const index = addSymbol(
        context,
        node,
        name,
        className ? "method" : "function",
        parentSymbol,
        className,
      );
      const body = field(node, "body");
      if (body) for (const child of children(body)) walk(child, context, index, null);
      return;
    }

    case "class_definition": {
      const name = field(node, "name")?.text;
      if (!name) return;
      const index = addSymbol(context, node, name, "class", parentSymbol, null);

      const superclasses = field(node, "superclasses");
      if (superclasses) {
        for (const base of children(superclasses)) {
          addReference(context, lastIdentifier(base.text), "extends", base, index);
        }
      }

      const body = field(node, "body");
      if (body) for (const child of children(body)) walk(child, context, index, name);
      return;
    }

    case "assignment": {
      const left = field(node, "left");
      const name = left?.type === "identifier" ? left.text : null;
      if (name && parentSymbol === null && /^[A-Z0-9_]+$/.test(name)) {
        addSymbol(context, node, name, "constant", null, null, collapse(node.text, 160));
      }
      for (const child of children(node)) walk(child, context, parentSymbol, className);
      return;
    }

    case "call": {
      const callee = field(node, "function");
      if (callee) addReference(context, lastIdentifier(callee.text), "call", node, parentSymbol);
      for (const child of children(node)) walk(child, context, parentSymbol, className);
      return;
    }

    default:
      for (const child of children(node)) walk(child, context, parentSymbol, className);
  }
}

/** @app.get("/users") and @app.route("/users") become route symbols (PRD 16). */
function routeFromDecorators(decorators: Node[]): string | null {
  for (const decorator of decorators) {
    const text = decorator.text.replace(/^@/, "");
    const match = /^([\w.]+)\.(\w+)\(\s*["']([^"']+)["']/.exec(text);
    if (!match) continue;
    const method = (match[2] ?? "").toLowerCase();
    const routePath = match[3] ?? "";
    if (!HTTP_METHODS.has(method) || !routePath.startsWith("/")) continue;
    return `${method === "route" ? "ANY" : method.toUpperCase()} ${routePath}`;
  }
  return null;
}

function lastIdentifier(text: string): string {
  const cleaned = text.split("(")[0] ?? text;
  const parts = cleaned.split(".");
  return (parts[parts.length - 1] ?? cleaned).trim();
}

export const pythonParser: LanguageParser = new PythonParser();
