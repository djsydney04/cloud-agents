const js = require("@eslint/js");
const globals = require("globals");
module.exports = [
  {
    files: ["tests/electron-ui.cjs"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        innerWidth: "readonly",
      },
    },
  },
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "native/**",
      "target/**",
      "test-results/**",
    ],
  },
  {
    files: ["ui/**/*.js", "desktop/**/*.cjs", "tests/**/*.cjs"],
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["ui/**/*.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
    rules: {
      "no-restricted-globals": ["error", "require", "process", "Buffer"],
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
  {
    files: ["desktop/**/*.cjs", "tests/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },
];
