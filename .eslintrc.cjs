module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-console": "off",
  },
  overrides: [
    {
      files: ["packages/web/**/*.{ts,tsx}"],
      extends: ["next/core-web-vitals"],
      rules: {
        "no-console": "warn",
      },
    },
  ],
  ignorePatterns: ["dist/", "node_modules/", ".next/", "*.js"],
};
