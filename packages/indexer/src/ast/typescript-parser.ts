import crypto from "node:crypto";
import type { Node } from "web-tree-sitter";
import { parserFor } from "./tree-sitter-loader.js";
import {
  emptyParseResult,
  type LanguageParser,
  type ParsedImport,
  type ParsedReference,
  type ParsedSymbol,
  type ParseInput,
  type ParseResult,
  type SymbolType,
} from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const ROUTER_OBJECTS = /^(app|router|server|api|v\d+)$/i;

function children(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

function hashOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function collapse(text: string, limit = 240): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}...` : single;
}

/** Everything up to the body: name, parameters, return type. */
function signatureOf(node: Node): string {
  const body = field(node, "body");
  const end = body ? body.startIndex : node.endIndex;
  return collapse(node.text.slice(0, Math.max(0, end - node.startIndex)));
}

function stringLiteralValue(node: Node | null): string | null {
  if (!node) return null;
  if (node.type !== "string" && node.type !== "template_string") return null;
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

/**
 * Symbol, import and reference extraction for TypeScript, TSX and JavaScript.
 * The tree is walked explicitly rather than queried: node-type switches stay
 * readable, degrade predictably across grammar versions, and make it obvious which
 * constructs are deliberately ignored.
 */
class TypeScriptParser implements LanguageParser {
  readonly name = "typescript";
  readonly languages = ["typescript", "javascript"] as const;
  readonly grammars = ["typescript", "tsx", "javascript"] as const;

  parse(input: ParseInput): ParseResult {
    const grammar = grammarFor(input.relativePath, input.language);
    const tree = parserFor(grammar).parse(input.content);
    const result = emptyParseResult(input.language);
    if (!tree?.rootNode) return result;

    result.hasErrors = tree.rootNode.hasError;
    const context: WalkContext = {
      input,
      isJsxFile: /\.(tsx|jsx)$/i.test(input.relativePath),
      symbols: result.symbols,
      imports: result.imports,
      references: result.references,
    };

    for (const child of children(tree.rootNode)) walk(child, context, null, false);
    tree.delete();
    return result;
  }
}

interface WalkContext {
  input: ParseInput;
  isJsxFile: boolean;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  references: ParsedReference[];
}

function grammarFor(relativePath: string, language: string): string {
  if (/\.(tsx|jsx)$/i.test(relativePath)) return "tsx";
  if (language === "javascript") return "javascript";
  return "typescript";
}

function addSymbol(
  context: WalkContext,
  node: Node,
  name: string,
  type: SymbolType,
  options: { exported: boolean; parentIndex: number | null; signature?: string; qualifiedPrefix?: string },
): number {
  const qualifiedName = options.qualifiedPrefix ? `${options.qualifiedPrefix}.${name}` : name;
  context.symbols.push({
    name,
    qualifiedName,
    type,
    signature: options.signature ?? signatureOf(node),
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    exported: options.exported,
    parentIndex: options.parentIndex,
    hash: hashOf(node.text),
  });
  return context.symbols.length - 1;
}

function addReference(context: WalkContext, name: string, kind: ParsedReference["kind"], node: Node, from: number | null): void {
  if (!name || name.length > 200) return;
  context.references.push({ name, kind, line: node.startPosition.row + 1, fromSymbolIndex: from });
}

/** function/const symbols get refined into React components and hooks (PRD 16). */
function refineFunctionType(context: WalkContext, name: string, node: Node): SymbolType {
  if (/^use[A-Z]/.test(name)) return "hook";
  if (/^[A-Z]/.test(name)) {
    if (context.isJsxFile) return "component";
    if (node.text.includes("React.createElement")) return "component";
  }
  return "function";
}

function importNames(clause: Node | null): string[] {
  if (!clause) return [];
  const names: string[] = [];
  const visit = (node: Node): void => {
    switch (node.type) {
      case "identifier":
        names.push(node.text);
        return;
      case "import_specifier": {
        const alias = field(node, "alias");
        const name = field(node, "name");
        names.push((alias ?? name)?.text ?? node.text);
        return;
      }
      case "namespace_import": {
        const identifier = children(node).find((child) => child.type === "identifier");
        if (identifier) names.push(identifier.text);
        return;
      }
      default:
        for (const child of children(node)) visit(child);
    }
  };
  visit(clause);
  return [...new Set(names)];
}

function walk(node: Node, context: WalkContext, parentSymbol: number | null, insideSymbol: boolean): void {
  switch (node.type) {
    case "import_statement": {
      const specifier = stringLiteralValue(field(node, "source"));
      if (specifier) {
        const isType = node.text.startsWith("import type");
        context.imports.push({
          specifier,
          kind: isType ? "type" : "static",
          line: node.startPosition.row + 1,
          names: importNames(children(node).find((child) => child.type === "import_clause") ?? null),
        });
      }
      return;
    }

    case "export_statement": {
      const source = stringLiteralValue(field(node, "source"));
      if (source) {
        // export { x } from "./y" - a dependency edge just like an import.
        context.imports.push({ specifier: source, kind: "export_from", line: node.startPosition.row + 1, names: [] });
        return;
      }
      const declaration = field(node, "declaration") ?? field(node, "value");
      if (declaration) walkDeclaration(declaration, context, parentSymbol, true, insideSymbol);
      return;
    }

    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration":
    case "lexical_declaration":
    case "variable_declaration":
      walkDeclaration(node, context, parentSymbol, false, insideSymbol);
      return;

    case "arrow_function":
    case "function_expression":
    case "generator_function": {
      // Anything inside a function body - including a callback passed to another
      // call - is local detail, so declarations below here are not symbols.
      for (const child of children(node)) walk(child, context, parentSymbol, true);
      return;
    }

    case "call_expression": {
      recordCall(node, context, parentSymbol);
      for (const child of children(node)) walk(child, context, parentSymbol, insideSymbol);
      return;
    }

    case "new_expression": {
      const constructor = field(node, "constructor");
      if (constructor) addReference(context, lastIdentifier(constructor), "new", node, parentSymbol);
      for (const child of children(node)) walk(child, context, parentSymbol, insideSymbol);
      return;
    }

    case "jsx_opening_element":
    case "jsx_self_closing_element": {
      const name = field(node, "name");
      if (name && /^[A-Z]/.test(name.text)) addReference(context, name.text, "jsx", node, parentSymbol);
      for (const child of children(node)) walk(child, context, parentSymbol, insideSymbol);
      return;
    }

    case "decorator": {
      const name = lastIdentifier(node);
      if (name) addReference(context, name, "decorator", node, parentSymbol);
      for (const child of children(node)) walk(child, context, parentSymbol, insideSymbol);
      return;
    }

    default:
      for (const child of children(node)) walk(child, context, parentSymbol, insideSymbol);
  }
}

function walkDeclaration(
  node: Node,
  context: WalkContext,
  parentSymbol: number | null,
  exported: boolean,
  insideSymbol: boolean,
): void {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = field(node, "name")?.text;
      // Functions nested inside another function are implementation detail, not API.
      if (!name || insideSymbol) return walkBody(node, context, parentSymbol, true);
      const index = addSymbol(context, node, name, refineFunctionType(context, name, node), { exported, parentIndex: parentSymbol });
      walkBody(node, context, index, true);
      return;
    }

    case "class_declaration":
    case "abstract_class_declaration": {
      const name = field(node, "name")?.text;
      if (!name) return;
      const index = addSymbol(context, node, name, "class", {
        exported,
        parentIndex: parentSymbol,
        signature: collapse(node.text.slice(0, Math.max(0, (field(node, "body")?.startIndex ?? node.endIndex) - node.startIndex))),
      });
      recordHeritage(node, context, index);
      const body = field(node, "body");
      if (body) for (const member of children(body)) walkClassMember(member, context, index, name);
      return;
    }

    case "interface_declaration": {
      const name = field(node, "name")?.text;
      if (name) {
        const index = addSymbol(context, node, name, "interface", { exported, parentIndex: parentSymbol });
        recordHeritage(node, context, index);
      }
      return;
    }

    case "type_alias_declaration": {
      const name = field(node, "name")?.text;
      if (name) addSymbol(context, node, name, "type", { exported, parentIndex: parentSymbol });
      return;
    }

    case "enum_declaration": {
      const name = field(node, "name")?.text;
      if (name) addSymbol(context, node, name, "enum", { exported, parentIndex: parentSymbol });
      return;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      for (const declarator of children(node).filter((child) => child.type === "variable_declarator")) {
        const name = field(declarator, "name")?.text;
        const value = field(declarator, "value");
        if (!name) continue;

        if (insideSymbol) {
          if (value) walk(value, context, parentSymbol, true);
          continue;
        }

        const isFunction = value !== null && (value.type === "arrow_function" || value.type === "function_expression");
        const type: SymbolType = isFunction
          ? refineFunctionType(context, name, value)
          : /^[A-Z0-9_]+$/.test(name)
            ? "constant"
            : "variable";

        const index = addSymbol(context, declarator, name, type, {
          exported,
          parentIndex: parentSymbol,
          signature: isFunction && value ? collapse(value.text.slice(0, Math.max(0, (field(value, "body")?.startIndex ?? value.endIndex) - value.startIndex))) : collapse(declarator.text, 160),
        });
        if (value) walk(value, context, index, true);
      }
      return;
    }

    default:
      walk(node, context, parentSymbol, insideSymbol);
  }
}

function walkClassMember(member: Node, context: WalkContext, classIndex: number, className: string): void {
  switch (member.type) {
    case "method_definition":
    case "abstract_method_signature": {
      const name = field(member, "name")?.text;
      if (!name) return;
      const index = addSymbol(context, member, name, "method", {
        exported: false,
        parentIndex: classIndex,
        qualifiedPrefix: className,
      });
      walkBody(member, context, index, true);
      return;
    }

    case "public_field_definition":
    case "field_definition": {
      const name = field(member, "name")?.text;
      if (!name) return;
      const value = field(member, "value");
      const isFunction = value !== null && (value.type === "arrow_function" || value.type === "function_expression");
      const index = addSymbol(context, member, name, isFunction ? "method" : "property", {
        exported: false,
        parentIndex: classIndex,
        qualifiedPrefix: className,
        signature: collapse(member.text, 160),
      });
      if (value) walk(value, context, index, true);
      return;
    }

    default:
      walk(member, context, classIndex, true);
  }
}

function walkBody(node: Node, context: WalkContext, symbolIndex: number | null, insideSymbol: boolean): void {
  const body = field(node, "body");
  if (body) walk(body, context, symbolIndex, insideSymbol);
}

function recordHeritage(node: Node, context: WalkContext, symbolIndex: number): void {
  for (const child of children(node)) {
    if (child.type !== "class_heritage" && child.type !== "extends_type_clause" && child.type !== "extends_clause") continue;
    for (const clause of [child, ...children(child)]) {
      const kind = clause.type === "implements_clause" ? "implements" : "extends";
      for (const name of typeNames(clause)) addReference(context, name, kind, clause, symbolIndex);
    }
  }
}

function typeNames(node: Node): string[] {
  const names: string[] = [];
  for (const child of children(node)) {
    if (child.type === "identifier" || child.type === "type_identifier") names.push(child.text);
    else if (child.type === "generic_type" || child.type === "member_expression" || child.type === "nested_type_identifier") {
      const name = lastIdentifier(child);
      if (name) names.push(name);
    }
  }
  return names;
}

function recordCall(node: Node, context: WalkContext, parentSymbol: number | null): void {
  const callee = field(node, "function");
  if (!callee) return;

  if (callee.type === "import") {
    const argument = children(field(node, "arguments") ?? node)[0];
    const specifier = stringLiteralValue(argument ?? null);
    if (specifier) {
      context.imports.push({ specifier, kind: "dynamic", line: node.startPosition.row + 1, names: [] });
    }
    return;
  }

  if (callee.type === "identifier" && callee.text === "require") {
    const argument = children(field(node, "arguments") ?? node)[0];
    const specifier = stringLiteralValue(argument ?? null);
    if (specifier) {
      context.imports.push({ specifier, kind: "require", line: node.startPosition.row + 1, names: [] });
    }
    return;
  }

  if (callee.type === "member_expression") {
    const object = field(callee, "object");
    const property = field(callee, "property");
    const method = property?.text ?? "";

    // Express-style route registration: app.get("/users", handler)
    if (object && property && HTTP_METHODS.has(method.toLowerCase()) && ROUTER_OBJECTS.test(lastIdentifier(object))) {
      const argument = children(field(node, "arguments") ?? node)[0];
      const routePath = stringLiteralValue(argument ?? null);
      if (routePath?.startsWith("/")) {
        addSymbol(context, node, `${method.toUpperCase()} ${routePath}`, "route", {
          exported: false,
          parentIndex: parentSymbol,
          signature: collapse(node.text, 160),
        });
      }
    }

    if (method) addReference(context, method, "call", node, parentSymbol);
    return;
  }

  if (callee.type === "identifier") addReference(context, callee.text, "call", node, parentSymbol);
}

/** Rightmost identifier of a dotted expression: a.b.C -> C. */
function lastIdentifier(node: Node): string {
  if (node.type === "identifier" || node.type === "type_identifier" || node.type === "property_identifier") return node.text;
  const parts = node.text.split(".");
  return (parts[parts.length - 1] ?? node.text).trim();
}

export const typescriptParser: LanguageParser = new TypeScriptParser();
