module.exports = {
  root: true,
  env: {
    node: true
  },
  extends: ["plugin:vue/recommended", "prettier/vue"],
  rules: {
    "vue/component-name-in-template-casing": ["error", "PascalCase"],
    "comma-dangle": ["error", "always-multiline"],
    indent: ["error", 2],
    quotes: ["error", "single"],
    "no-console": process.env.NODE_ENV === "production" ? "error" : "off",
    "no-debugger": process.env.NODE_ENV === "production" ? "error" : "off"
  },
  parserOptions: {
    parser: "babel-eslint"
  }
};
