import { ESLint } from "eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL("../..", import.meta.url));
const VIRTUAL_RESOLVER = fileURLToPath(new URL("./virtual-resolver.cjs", import.meta.url));
const RULE = "import/no-restricted-paths";

/**
 * Lints in-memory source as if it lived at `filePath`, using the package's real ESLint config.
 * Typed linting is off because the file is not on disk; `virtualTargets` lets imports resolve to
 * files that later tickets will create.
 */
async function restrictedImports(
  filePath: string,
  importPath: string,
  { virtualTargets = false } = {},
): Promise<string[]> {
  const eslint = new ESLint({
    cwd: SERVER_DIR,
    overrideConfig: {
      parserOptions: { project: false },
      rules: { "@typescript-eslint/strict-boolean-expressions": "off" },
      ...(virtualTargets ? { settings: { "import/resolver": { [VIRTUAL_RESOLVER]: {} } } } : {}),
    },
  });
  const code = `import * as target from "${importPath}";\n\nexport const used = target;\n`;
  const [result] = await eslint.lintText(code, { filePath: path.join(SERVER_DIR, filePath) });

  const fatal = result?.messages.filter((message) => message.fatal === true) ?? [];
  expect(fatal).toEqual([]);
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.message);
}

// The first lint loads every plugin and resolver; on a busy machine that alone can take >5 s.
describe("dependency direction lint rule", { timeout: 20_000 }, () => {
  it.each(["../../llm/openai-compatible.js", "../../llm/demo.js"])(
    "forbids a module importing the LLM adapter %s",
    async (adapter) => {
      const errors = await restrictedImports("src/modules/messages/service.ts", adapter, {
        virtualTargets: true,
      });

      expect(errors).toHaveLength(1);
    },
  );

  it("allows a module to import the LLM port", async () => {
    const errors = await restrictedImports("src/modules/messages/service.ts", "../../llm/port.js", {
      virtualTargets: true,
    });

    expect(errors).toEqual([]);
  });

  it.each([
    ["src/llm/registry.ts", "../modules/health/routes.js"],
    ["src/credentials/decide.ts", "../modules/health/routes.js"],
    ["src/db/schema.ts", "../modules/health/routes.js"],
    ["src/db/schema.ts", "../http/problem-details.js"],
  ])("forbids %s importing %s", async (file, target) => {
    const errors = await restrictedImports(file, target);

    expect(errors).toHaveLength(1);
  });

  it("allows a module to import shared HTTP helpers", async () => {
    const errors = await restrictedImports(
      "src/modules/sessions/routes.ts",
      "../../http/problem-details.js",
    );

    expect(errors).toEqual([]);
  });
});
