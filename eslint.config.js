import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // A catch that discards an error must say which error and why.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  // The tapestry's browser-side modules; its .mjs files run under node or both.
  {
    files: ["tapestry/weave.js", "tapestry/fabric.js", "tapestry/yarn.js"],
    languageOptions: { globals: globals.browser },
  },
];
