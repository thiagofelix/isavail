/**
 * Project lint rules that enforce `docs/coding-standards.md` conventions the
 * stock Oxlint rules cannot express.
 */

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * True when an import source refers to code owned by this repository rather
 * than to an installed library.
 *
 * @param {string} source - Module specifier written in the import declaration.
 * @returns {boolean}
 */
const isProjectLocalSource = (source) => source.startsWith(".") || source.startsWith("@isavail/");

import { definePlugin, defineRule } from "@oxlint/plugins";

const plugin = definePlugin({
  meta: { name: "isavail" },
  rules: {
    "no-service-constructor-import": defineRule({
      meta: {
        type: "problem",
        docs: {
          description:
            "Runtime modules import a capability's Layer and yield its service instead of importing its make<Capability> constructor.",
        },
        messages: {
          serviceConstructorImport:
            "Import the Layer that owns `{{name}}` and yield its contextual service instead. Only *.test.* and *.spec.* files may import service constructors.",
        },
        schema: [],
      },
      create(context) {
        if (TEST_FILE.test(context.filename)) {
          return {};
        }

        return {
          ImportDeclaration(node) {
            if (!isProjectLocalSource(node.source.value)) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (specifier.type !== "ImportSpecifier") {
                continue;
              }

              const name =
                specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : specifier.imported.value;

              if (SERVICE_CONSTRUCTOR_NAME.test(name)) {
                context.report({
                  node: specifier,
                  messageId: "serviceConstructorImport",
                  data: { name },
                });
              }
            }
          },
        };
      },
    }),
  },
});

export default plugin;
