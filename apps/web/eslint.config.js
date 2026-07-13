import js from "@eslint/js";
import globals from "globals";
import reactCompiler from "eslint-plugin-react-compiler";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const featureNames = ["chat", "editor", "git-status", "keyboard-shortcuts"];

// Non-feature code must consume features through public entry modules.
// The remaining one-line component shims and the chat entry modules are
// sanctioned crossings; everything else deep-importing a feature is a
// boundary violation.
const featureEntryPoints = [
  "src/components/FileEditorTab.tsx",
  "src/components/GitDiffTab.tsx",
  "src/components/WorktreeGitStatusPanel.tsx",
];

const nonFeatureBoundary = {
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["src/features/**", ...featureEntryPoints],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex:
              "^@/features/(?!chat/(?:CopilotKitAgentChatTab|WorktreeChatsPanel)$|chat/classic/AgentChatTabClassicView$)[^/]+/.",
            message: "Import features through public entry modules only.",
          },
        ],
      },
    ],
  },
};

function featureBoundary(featureName) {
  return {
    files: [`src/features/${featureName}/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^@/features/(?!${featureName}(?:/|$))[^/]+/`,
              message:
                "Import another feature through its index re-export only.",
            },
            {
              regex: "^\\.\\./",
              message:
                "Use @/ imports; feature parent traversals can bypass boundaries.",
            },
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/",
      "node_modules/",
      "playwright-report/",
      "test-results/",
      "src/lib/components/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-compiler": reactCompiler,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-compiler/react-compiler": "warn",
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  ...featureNames.map(featureBoundary),
  nonFeatureBoundary,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/*.generated.*",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
    ],
    rules: {
      "max-lines": [
        "warn",
        { max: 800, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["src/lib/stores/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/components", "@/components/**"],
              message: "Stores cannot depend on React components.",
            },
            {
              group: ["@/features", "@/features/**"],
              message: "Stores cannot depend on frontend features.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/heavy/**/*.{ts,tsx}",
      "src/features/chat/CopilotKitAgentChatTab.tsx",
      "src/components/AgentChatTabSwitch.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value=/^(?:@monaco-editor\\/|monaco-editor(?:\\/|$)|@assistant-ui\\/|@copilotkit\\/|@ag-ui\\/)/]",
          message:
            "Heavy UI packages belong in lib/heavy or a lazy chat entry point.",
        },
        {
          selector:
            "ImportExpression[source.value=/^(?:@monaco-editor\\/|monaco-editor(?:\\/|$)|@assistant-ui\\/|@copilotkit\\/|@ag-ui\\/)/]",
          message:
            "Heavy UI packages belong in lib/heavy or a lazy chat entry point.",
        },
      ],
    },
  },
  {
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["src/components/ui/sidebar.tsx"],
    rules: {
      "react-hooks/purity": "off",
    },
  },
);
