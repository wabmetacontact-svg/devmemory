import fs from "node:fs";
import path from "node:path";
import type { ProjectDetection } from "@samirthakur024/shared";

export interface DetectionContext {
  root: string;
  has(relative: string): boolean;
  read(relative: string): string | null;
  packageJson: PackageJsonLike | null;
  dependencies: Record<string, string>;
}

export interface PackageJsonLike {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
}

export interface FrameworkDetector {
  /** Reported framework name. */
  name: string;
  /** Higher wins when several detectors match; Next.js should beat plain React. */
  priority: number;
  detect(context: DetectionContext): boolean;
}

const dep = (context: DetectionContext, ...names: string[]): boolean =>
  names.some((name) => name in context.dependencies);

const pythonMentions = (context: DetectionContext, needle: string): boolean => {
  const sources = ["requirements.txt", "pyproject.toml", "Pipfile", "environment.yml"];
  return sources.some((file) => (context.read(file) ?? "").toLowerCase().includes(needle));
};

/**
 * Framework detection is a registry of small independent detectors (PRD 19:
 * "framework detection must be modular"). Adding a stack means adding one entry.
 */
export const FRAMEWORK_DETECTORS: FrameworkDetector[] = [
  { name: "Next.js", priority: 100, detect: (c) => dep(c, "next") || c.has("next.config.js") || c.has("next.config.ts") || c.has("next.config.mjs") },
  { name: "Nuxt", priority: 100, detect: (c) => dep(c, "nuxt", "nuxt3") || c.has("nuxt.config.ts") || c.has("nuxt.config.js") },
  { name: "Expo", priority: 95, detect: (c) => dep(c, "expo") || c.has("app.json") && (c.read("app.json") ?? "").includes("\"expo\"") },
  { name: "React Native", priority: 90, detect: (c) => dep(c, "react-native") },
  { name: "Angular", priority: 90, detect: (c) => dep(c, "@angular/core") || c.has("angular.json") },
  { name: "NestJS", priority: 90, detect: (c) => dep(c, "@nestjs/core") },
  { name: "SvelteKit", priority: 90, detect: (c) => dep(c, "@sveltejs/kit") },
  { name: "Remix", priority: 90, detect: (c) => dep(c, "@remix-run/react", "@remix-run/node") },
  { name: "Astro", priority: 90, detect: (c) => dep(c, "astro") },
  { name: "Vue", priority: 70, detect: (c) => dep(c, "vue") },
  { name: "Svelte", priority: 70, detect: (c) => dep(c, "svelte") },
  { name: "React", priority: 60, detect: (c) => dep(c, "react") },
  { name: "Express", priority: 60, detect: (c) => dep(c, "express") },
  { name: "Fastify", priority: 60, detect: (c) => dep(c, "fastify") },
  { name: "Django", priority: 100, detect: (c) => c.has("manage.py") || pythonMentions(c, "django") },
  { name: "FastAPI", priority: 100, detect: (c) => pythonMentions(c, "fastapi") },
  { name: "Flask", priority: 90, detect: (c) => pythonMentions(c, "flask") },
  { name: "Laravel", priority: 100, detect: (c) => c.has("artisan") },
  { name: "Flutter", priority: 100, detect: (c) => c.has("pubspec.yaml") && (c.read("pubspec.yaml") ?? "").includes("flutter") },
];

interface LanguageMarker {
  language: string;
  markers: string[];
}

const LANGUAGE_MARKERS: LanguageMarker[] = [
  { language: "TypeScript", markers: ["tsconfig.json", "tsconfig.base.json"] },
  { language: "JavaScript", markers: ["package.json", "jsconfig.json"] },
  { language: "Python", markers: ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg"] },
  { language: "Go", markers: ["go.mod"] },
  { language: "Rust", markers: ["Cargo.toml"] },
  { language: "Java", markers: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { language: "PHP", markers: ["composer.json"] },
  { language: "Ruby", markers: ["Gemfile"] },
  { language: "Dart", markers: ["pubspec.yaml"] },
  { language: "C#", markers: ["global.json"] },
];

const PACKAGE_MANAGER_LOCKFILES: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
  ["Pipfile.lock", "pipenv"],
  ["requirements.txt", "pip"],
  ["Cargo.lock", "cargo"],
  ["go.sum", "go"],
  ["composer.lock", "composer"],
  ["Gemfile.lock", "bundler"],
  ["pubspec.lock", "pub"],
];

export function createDetectionContext(root: string): DetectionContext {
  const cache = new Map<string, string | null>();

  const read = (relative: string): string | null => {
    if (cache.has(relative)) return cache.get(relative) ?? null;
    let value: string | null = null;
    try {
      const target = path.join(root, relative);
      const stat = fs.statSync(target);
      // Manifests are small; a bad glob should never pull a huge file into memory.
      if (stat.isFile() && stat.size <= 512 * 1024) value = fs.readFileSync(target, "utf8");
    } catch {
      value = null;
    }
    cache.set(relative, value);
    return value;
  };

  const has = (relative: string): boolean => {
    try {
      return fs.existsSync(path.join(root, relative));
    } catch {
      return false;
    }
  };

  let packageJson: PackageJsonLike | null = null;
  const rawPackageJson = read("package.json");
  if (rawPackageJson) {
    try {
      packageJson = JSON.parse(rawPackageJson) as PackageJsonLike;
    } catch {
      packageJson = null;
    }
  }

  const dependencies: Record<string, string> = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
    ...(packageJson?.peerDependencies ?? {}),
  };

  return { root, has, read, packageJson, dependencies };
}

export function detectFrameworks(context: DetectionContext): string[] {
  return FRAMEWORK_DETECTORS.filter((detector) => {
    try {
      return detector.detect(context);
    } catch {
      return false;
    }
  })
    .sort((a, b) => b.priority - a.priority)
    .map((detector) => detector.name);
}

export function detectLanguages(context: DetectionContext): string[] {
  const languages = LANGUAGE_MARKERS.filter((entry) => entry.markers.some((marker) => context.has(marker))).map(
    (entry) => entry.language,
  );

  if (context.has("global.json") || hasExtension(context.root, ".csproj") || hasExtension(context.root, ".sln")) {
    if (!languages.includes("C#")) languages.push("C#");
  }
  return languages;
}

export function detectPackageManager(context: DetectionContext): string | null {
  const declared = context.packageJson?.packageManager;
  if (declared) {
    const name = declared.split("@")[0]?.trim();
    if (name) return name;
  }
  for (const [lockfile, manager] of PACKAGE_MANAGER_LOCKFILES) {
    if (context.has(lockfile)) return manager;
  }
  return context.packageJson ? "npm" : null;
}

export function detectProject(root: string): ProjectDetection {
  const context = createDetectionContext(root);
  const frameworks = detectFrameworks(context);
  return {
    framework: frameworks[0] ?? null,
    frameworks,
    languages: detectLanguages(context),
    packageManager: detectPackageManager(context),
  };
}

function hasExtension(root: string, extension: string): boolean {
  try {
    return fs.readdirSync(root).some((entry) => entry.toLowerCase().endsWith(extension));
  } catch {
    return false;
  }
}
