import path from "node:path";

/** Extension to language mapping. v1 indexes everything but only claims first-class
 *  understanding of TypeScript, JavaScript and Python (PRD 18). */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".php": "php",
  ".rb": "ruby",
  ".cs": "csharp",
  ".dart": "dart",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".vue": "vue",
  ".svelte": "svelte",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".md": "markdown",
  ".mdx": "markdown",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".tf": "terraform",
  ".prisma": "prisma",
};

/** Languages whose files carry code intelligence value. */
export const CODE_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "php",
  "ruby",
  "csharp",
  "dart",
  "swift",
  "c",
  "cpp",
  "vue",
  "svelte",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z", ".bz2", ".xz",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".webm", ".flac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
  ".class", ".jar", ".wasm", ".pyc", ".pyo", ".node",
  ".db", ".sqlite", ".sqlite3", ".mdb", ".dat", ".pack", ".idx",
  ".psd", ".ai", ".sketch", ".fig", ".xlsx", ".docx", ".pptx",
]);

export function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function languageOf(filePath: string): string | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(filePath)] ?? null;
}

export function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(filePath));
}

export function isCodeFile(filePath: string): boolean {
  const language = languageOf(filePath);
  return language !== null && CODE_LANGUAGES.has(language);
}
