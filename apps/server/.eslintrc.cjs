/* eslint-env node */
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended",
    "plugin:import-esm/recommended",
  ],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "import", "prettier"],
  rules: {
    "eqeqeq": ["error", "always"],
    "no-console": "warn",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    "@typescript-eslint/no-namespace": "off",
    "@typescript-eslint/strict-boolean-expressions": [
      "error",
      {
        allowString: false,
        allowNumber: false,
        allowNullableObject: false,
        allowNullableEnum: false,
      },
    ],
    "prettier/prettier": "error",
    // Dependency direction: routes → service → port ← adapter.
    "import/no-restricted-paths": [
      "error",
      {
        basePath: __dirname,
        zones: [
          {
            target: "./src/modules",
            // Deny-list: add every new LLM adapter file here.
            from: ["./src/llm/openai-compatible.ts", "./src/llm/demo.ts"],
            message: "Modules use the LLM port and registry, never an adapter directly.",
          },
          {
            target: ["./src/llm", "./src/credentials"],
            from: "./src/modules",
            message: "LLM and credential code must not depend on feature modules.",
          },
          {
            target: "./src/db",
            from: ["./src/modules", "./src/http"],
            message: "Database code must not depend on feature modules or HTTP.",
          },
        ],
      },
    ],
  },
  settings: {
    // Resolves "./x.js" to "./x.ts"; without it import/* rules silently skip every relative import.
    "import/resolver": {
      typescript: { project: `${__dirname}/tsconfig.json` },
    },
  },
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    project: true,
    tsconfigRootDir: __dirname,
  },
};
