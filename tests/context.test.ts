import { afterAll, describe, expect, it } from "vitest";
import { detectIntent, parseRequest } from "@samirthakur024/core";
import { splitIdentifier, toMatchQuery } from "@samirthakur024/indexer";
import { FAKE_SECRETS, cleanupAll, makeDevMemory, makeProject, removeFile, writeFile } from "./helpers.js";

afterAll(cleanupAll);

const FIXTURE = {
  "package.json": JSON.stringify({ name: "shop", dependencies: { express: "4.18.0" } }),
  "src/payment/PaymentService.ts": `import { TransactionRepository } from "../db/TransactionRepository";

export class PaymentService {
  constructor(private repository: TransactionRepository) {}

  /** Verifies that a payment webhook has not already been processed. */
  async verifyPayment(paymentId: string) {
    const existing = await this.repository.findByPaymentId(paymentId);
    return existing === null;
  }
}
`,
  "src/payment/WebhookHandler.ts": `import { PaymentService } from "./PaymentService";

export async function handleWebhook(service: PaymentService, paymentId: string) {
  return service.verifyPayment(paymentId);
}
`,
  "src/db/TransactionRepository.ts": `export class TransactionRepository {
  async findByPaymentId(paymentId: string) {
    return paymentId ? null : null;
  }
}
`,
  "src/auth/LoginForm.tsx": `export function LoginForm() {
  return <form />;
}
`,
  "src/util/formatting.ts": `export function formatCurrency(amount: number) {
  return amount.toFixed(2);
}
`,
  "tests/payment.test.ts": `import { PaymentService } from "../src/payment/PaymentService";

test("verifies", () => new PaymentService({} as never));
`,
  "docs/architecture.md": "# Architecture\n\nPayments are verified once per webhook using idempotency keys.\n",
};

async function fixture() {
  const root = makeProject({ name: "context", files: FIXTURE });
  const devmemory = makeDevMemory();
  const { project } = await devmemory.connect({ explicitRoot: root });
  return { root, devmemory, projectId: project.projectId, engine: devmemory.contextEngine(project.projectId) };
}

describe("intent detection (PRD 21)", () => {
  it.each([
    ["fix the crash in the login flow", "debug"],
    ["TypeError: cannot read property id of undefined", "debug"],
    ["add google authentication", "implement"],
    ["write tests for the payment webhook", "test"],
    ["refactor AuthService to remove duplication", "refactor"],
    ["why does the webhook run twice", "explain"],
    ["review the payment code for security issues", "review"],
  ])("classifies %s as %s", (task, expected) => {
    expect(detectIntent(task)).toBe(expected);
  });

  it("extracts symbols, paths and error signatures", () => {
    const parsed = parseRequest(
      "PaymentService.verifyPayment() throws TypeError: bad id in src/payment/WebhookHandler.ts",
    );

    expect(parsed.symbolCandidates).toEqual(expect.arrayContaining(["PaymentService", "verifyPayment"]));
    expect(parsed.pathCandidates).toContain("src/payment/WebhookHandler.ts");
    expect(parsed.errorSignature).toContain("TypeError");
    expect(parsed.terms).not.toContain("the");
  });
});

describe("full-text search (PRD 21, 53)", () => {
  it("finds code by natural phrasing", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const results = engine.searchContext("where is payment verification handled");
      const paths = results.map((result) => result.path);

      expect(paths).toContain("src/payment/PaymentService.ts");
      expect(results[0]?.relevance).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("matches split identifiers, so 'verify payment' finds verifyPayment", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const symbolHit = engine
        .searchContext("verify payment")
        .find((result) => result.symbol?.name.includes("verifyPayment"));

      expect(symbolHit).toBeDefined();
      expect(symbolHit?.kind).toBe("symbol");
    } finally {
      devmemory.close();
    }
  });

  it("searches prose files too", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const paths = engine.searchContext("idempotency keys").map((result) => result.path);
      expect(paths).toContain("docs/architecture.md");
    } finally {
      devmemory.close();
    }
  });

  it("returns a snippet located in the current file contents", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const hit = engine.searchContext("idempotency").find((result) => result.path === "docs/architecture.md");
      expect(hit?.snippet?.text).toContain("idempotency");
      expect(hit?.snippet?.line).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("drops a deleted file from the search index", async () => {
    const { root, devmemory, projectId, engine } = await fixture();
    try {
      expect(engine.searchContext("formatCurrency").some((r) => r.path === "src/util/formatting.ts")).toBe(true);

      removeFile(root, "src/util/formatting.ts");
      await devmemory.index(projectId);

      expect(engine.searchContext("formatCurrency").some((r) => r.path === "src/util/formatting.ts")).toBe(false);
    } finally {
      devmemory.close();
    }
  });

  it("keeps the search index isolated per project (AC-06)", async () => {
    const alpha = makeProject({
      name: "search-alpha",
      remote: "git@github.com:acme/search-alpha.git",
      files: { "package.json": "{}", "src/alpha.ts": "export const alphaSecretMarker = 1;\n" },
    });
    const beta = makeProject({
      name: "search-beta",
      remote: "git@github.com:acme/search-beta.git",
      files: { "package.json": "{}", "src/beta.ts": "export const betaMarker = 1;\n" },
    });

    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: alpha })).project;
      const b = (await devmemory.connect({ explicitRoot: beta })).project;

      expect(devmemory.contextEngine(a.projectId).searchContext("alphaSecretMarker").length).toBeGreaterThan(0);
      expect(devmemory.contextEngine(b.projectId).searchContext("alphaSecretMarker")).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });

  it("builds safe FTS queries from arbitrary text", () => {
    expect(toMatchQuery("what's broken? (payment)")).toContain('"payment"');
    expect(toMatchQuery("the a of")).toBeNull();
    expect(splitIdentifier("verifyPaymentID")).toBe("verify payment id");
    expect(splitIdentifier("find_by_payment_id")).toBe("find by payment id");
  });
});

describe("context assembly (PRD 22, 23, 24)", () => {
  it("selects the files that matter and says why", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const result = engine.getContext({ task: "fix payment verification running twice" });
      const paths = result.files.map((file) => file.path);

      expect(paths[0]).toBe("src/payment/PaymentService.ts");
      expect(paths).toContain("src/payment/WebhookHandler.ts");
      expect(result.files[0]?.reasons.length).toBeGreaterThan(0);
      expect(result.files[0]?.symbols.some((symbol) => symbol.name.includes("verifyPayment"))).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("leaves irrelevant files out and reports how many it avoided", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const result = engine.getContext({ task: "fix payment verification" });

      expect(result.files.map((file) => file.path)).not.toContain("src/auth/LoginForm.tsx");
      expect(result.filesAvoided).toBeGreaterThan(0);
      expect(result.filesSelected).toBeLessThan(result.filesConsidered + 1);
    } finally {
      devmemory.close();
    }
  });

  it("always includes explicitly requested paths", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const result = engine.getContext({ task: "something unrelated", paths: ["src/auth/LoginForm.tsx"] });

      expect(result.files[0]?.path).toBe("src/auth/LoginForm.tsx");
      expect(result.files[0]?.reasons).toContain("requested by the agent");
    } finally {
      devmemory.close();
    }
  });

  it("expands along the dependency graph", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const result = engine.getContext({ task: "change verifyPayment", depth: 1 });
      const paths = result.files.map((file) => file.path);

      expect(paths).toContain("src/db/TransactionRepository.ts");
      const repository = result.files.find((file) => file.path === "src/db/TransactionRepository.ts");
      expect(repository?.reasons.some((reason) => reason.startsWith("imported by"))).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("includes tests for test and debug intents", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const testing = engine.getContext({ task: "write tests for PaymentService" });
      expect(testing.files.map((file) => file.path)).toContain("tests/payment.test.ts");

      // A test file can still surface through search, but never as a dependent of the seeds.
      const implementing = engine.getContext({ task: "add a refund method to PaymentService", depth: 1 });
      const testFile = implementing.files.find((file) => file.path === "tests/payment.test.ts");
      expect(testFile?.reasons.some((reason) => reason.startsWith("tests "))).not.toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("respects the token budget and reports truncation", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const small = engine.getContext({ task: "payment verification webhook", maxTokens: 400 });
      const large = engine.getContext({ task: "payment verification webhook", maxTokens: 20_000 });

      expect(small.tokenEstimate).toBeLessThanOrEqual(400);
      expect(small.filesSelected).toBeLessThan(large.filesSelected);
      expect(small.truncated).toBe(true);
      expect(large.tokenEstimate).toBeGreaterThan(small.tokenEstimate);
    } finally {
      devmemory.close();
    }
  });

  it("returns structure only unless source is asked for", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const structural = engine.getContext({ task: "add a refund method to PaymentService", includeSource: false });
      expect(structural.files.every((file) => file.source === undefined)).toBe(true);
      expect(structural.includedSource).toBe(false);

      const withSource = engine.getContext({
        task: "add a refund method to PaymentService",
        includeSource: true,
        maxTokens: 20_000,
      });
      expect(withSource.includedSource).toBe(true);
      expect(withSource.files.find((file) => file.source)?.source?.text).toBeTruthy();
    } finally {
      devmemory.close();
    }
  });

  it("defaults to including source when the task is a debugging one", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const result = engine.getContext({ task: "fix the crash in verifyPayment", maxTokens: 20_000 });
      expect(result.intent).toBe("debug");
      expect(result.includedSource).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("redacts secrets in returned source", async () => {
    const { root, devmemory, projectId } = await fixture();
    try {
      writeFile(
        root,
        "src/payment/keys.ts",
        `export const STRIPE_SECRET_KEY = '${FAKE_SECRETS.stripeKeyAlt}';\n`,
      );
      await devmemory.index(projectId);

      const result = devmemory.contextEngine(projectId).getContext({
        task: "review STRIPE_SECRET_KEY usage",
        paths: ["src/payment/keys.ts"],
        includeSource: true,
        maxTokens: 20_000,
      });

      const source = result.files.find((file) => file.path === "src/payment/keys.ts")?.source?.text ?? "";
      expect(source).not.toContain(FAKE_SECRETS.stripeKeyAlt);
      expect(source).toContain("<REDACTED>");
    } finally {
      devmemory.close();
    }
  });

  it("still returns project metadata when nothing matches (L0)", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const result = engine.getContext({ task: "zzzzqqq nonexistent subsystem" });

      expect(result.project.name).toBe("shop");
      expect(result.project.branch).toBeTruthy();
      expect(result.tokenEstimate).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("reflects edits after a re-index", async () => {
    const { root, devmemory, projectId } = await fixture();
    try {
      writeFile(
        root,
        "src/payment/RefundService.ts",
        "export class RefundService {\n  issueRefund(id: string) {\n    return id;\n  }\n}\n",
      );
      await devmemory.index(projectId);

      const result = devmemory.contextEngine(projectId).getContext({ task: "implement issueRefund" });
      expect(result.files.map((file) => file.path)).toContain("src/payment/RefundService.ts");
    } finally {
      devmemory.close();
    }
  });
});

describe("retrieval quality regressions", () => {
  it("ignores Hinglish filler so a mixed-language request finds the same code", () => {
    const english = parseRequest("add a new field to the template type");
    const hinglish = parseRequest("template me ek naya field add karna hai");

    expect(hinglish.terms).toContain("template");
    for (const filler of ["me", "ek", "naya", "karna", "hai"]) {
      expect(hinglish.terms).not.toContain(filler);
    }
    // "naya" is filler where "new" is a word, so the lists are not identical - but
    // the terms that actually steer retrieval have to survive both phrasings.
    expect(hinglish.terms).toEqual(expect.arrayContaining(["template", "field"]));
    expect(english.terms).toEqual(expect.arrayContaining(["template", "field"]));
    expect(hinglish.intent).toBe(english.intent);
    expect(toMatchQuery("template me ek naya field add karna hai")).not.toMatch(/"karna"|"hai"/);
  });

  it("ranks a file whose name carries a query word above generic content matches", async () => {
    const root = makeProject({
      name: "ranking",
      files: {
        "package.json": JSON.stringify({ name: "ranking" }),
        "src/types/template.ts": "export interface Template {\n  id: string;\n}\n",
        // Mentions every generic word in the request, but nothing about templates.
        "src/pages/Login.tsx":
          "export function Login() {\n" +
          "  // add a new field, add another field, this type of field\n" +
          "  const field = 1;\n  const add = 2;\n  const type = 3;\n  return field + add + type;\n}\n",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const project = (await devmemory.connect({ explicitRoot: root })).project;
      const result = devmemory.contextEngine(project.projectId).getContext({
        task: "add a new field to the template type",
      });

      const paths = result.files.map((file) => file.path);
      expect(paths).toContain("src/types/template.ts");
      // The word that narrowed the search has to win, or the answer is noise.
      expect(paths.indexOf("src/types/template.ts")).toBeLessThan(
        paths.includes("src/pages/Login.tsx") ? paths.indexOf("src/pages/Login.tsx") : Number.MAX_SAFE_INTEGER,
      );
    } finally {
      devmemory.close();
    }
  });
});
