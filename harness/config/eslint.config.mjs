import stylistic from "@stylistic/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  {
    files: [
      "tools/**/*.mjs",
      "harness/src/**/*.mjs",
      "harness/support/**/*.mjs",
      "packaging/**/*.mjs",
    ],
    plugins: { "@stylistic": stylistic, jsdoc },
    rules: {
      "@stylistic/lines-around-comment": [
        "error",
        { beforeBlockComment: true, beforeLineComment: true },
      ],
      "jsdoc/require-jsdoc": [
        "error",
        {
          enableFixer: false,
          minLineCount: 6,
          require: { ArrowFunctionExpression: true, FunctionExpression: true },
        },
      ],
      "jsdoc/require-description": ["error", { descriptionStyle: "body" }],
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: typescriptParser },
    plugins: { "@stylistic": stylistic, jsdoc },
    settings: { jsdoc: { mode: "typescript" } },
    rules: {
      "@stylistic/lines-around-comment": [
        "error",
        { beforeBlockComment: true, beforeLineComment: true },
      ],
      "jsdoc/require-jsdoc": [
        "error",
        {
          enableFixer: false,
          require: { FunctionDeclaration: false },
          contexts: [
            {
              context:
                "FunctionDeclaration:not(ExportNamedDeclaration > FunctionDeclaration)",
              minLineCount: 6,
            },
            {
              context: "ExportNamedDeclaration > FunctionDeclaration",
              minLineCount: 1,
            },
            {
              context:
                "ExportNamedDeclaration[declaration.type='VariableDeclaration']",
              minLineCount: 1,
            },
            { context: "ClassDeclaration", minLineCount: 1 },
            { context: "TSTypeAliasDeclaration", minLineCount: 1 },
            { context: "TSInterfaceDeclaration", minLineCount: 1 },
            { context: "MethodDefinition", minLineCount: 1 },
            {
              context: "VariableDeclarator > ArrowFunctionExpression",
              minLineCount: 6,
            },
            {
              context: "VariableDeclarator > FunctionExpression",
              minLineCount: 6,
            },
          ],
        },
      ],
      "jsdoc/require-description": [
        "error",
        { descriptionStyle: "body", contexts: ["any"] },
      ],
    },
  },
];
