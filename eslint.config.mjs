import stylistic from "@stylistic/eslint-plugin";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  {
    files: ["tools/**/*.mjs"],
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
];
