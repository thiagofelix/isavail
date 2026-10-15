import { Schema, SchemaTransformation } from "effect";

const MAX_DOMAIN_NAME_LENGTH = 253;

/**
 * Category suffix appended to a bare name such as `minhaempresa`. `.com.br` is
 * the category most Brazilian companies register first.
 */
const DEFAULT_CATEGORY_SUFFIX = ".com.br";

/**
 * Registro.br accepts ASCII letters, digits, hyphens, and these Portuguese
 * letters in a label. The Registry still owns the finer rules, such as minimum
 * length and reserved words, and reports them as an unavailable domain.
 */
const LABEL_CHARACTER = "[a-z0-9àáâãéêíóôõúüç]";
const LABEL = `${LABEL_CHARACTER}(?:[a-z0-9àáâãéêíóôõúüç-]{0,61}${LABEL_CHARACTER})?`;
const DOMAIN_NAME_PATTERN = new RegExp(`^(?:${LABEL}\\.)+br$`);

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//;
const URL_PATH_QUERY_OR_FRAGMENT_PATTERN = /[/?#].*$/s;
const TRAILING_DOT_PATTERN = /\.$/;

/**
 * A lowercase, fully qualified domain name under `.br`, in its Unicode form,
 * such as `minhaempresa.com.br` or `açaí.com.br`.
 */
export const DomainName = Schema.String.check(
  Schema.isMaxLength(MAX_DOMAIN_NAME_LENGTH),
  Schema.isPattern(DOMAIN_NAME_PATTERN, {
    expected: "a lowercase domain name under .br, such as minhaempresa.com.br",
  }),
)
  .annotate({
    description: "A lowercase, fully qualified domain name under .br, in its Unicode form.",
    examples: ["minhaempresa.com.br"],
  })
  .pipe(Schema.brand("DomainName"));

/** A lowercase, fully qualified domain name under `.br`. */
export type DomainName = typeof DomainName.Type;

const removeUrlDecoration = (input: string): string =>
  input
    .replace(URL_SCHEME_PATTERN, "")
    .replace(URL_PATH_QUERY_OR_FRAGMENT_PATTERN, "")
    .replace(TRAILING_DOT_PATTERN, "");

const normalizeDomainNameInput = (input: string): string => {
  const host = removeUrlDecoration(input.trim().normalize("NFC").toLowerCase());

  return host.includes(".") ? host : `${host}${DEFAULT_CATEGORY_SUFFIX}`;
};

/**
 * Decodes what a person or an Agent typed into a {@link DomainName}.
 *
 * Decoding trims whitespace, lowercases, removes a URL scheme, path, query,
 * fragment, and trailing dot, and treats a bare name without a dot as a
 * `.com.br` domain. Encoding returns the canonical domain name.
 */
export const DomainNameFromInput = Schema.String.annotate({
  description:
    "A domain name under .br such as minhaempresa.com.br, or a bare name such as minhaempresa, which is checked as minhaempresa.com.br.",
  examples: ["minhaempresa.com.br"],
}).pipe(
  Schema.decodeTo(
    DomainName,
    SchemaTransformation.transform({
      decode: normalizeDomainNameInput,
      encode: (domainName) => domainName,
    }),
  ),
);

const decodeDomainNameInput = Schema.decodeEffect(DomainNameFromInput);

/**
 * Parses typed domain name input into a canonical {@link DomainName}.
 *
 * @param input - Text a person or an Agent entered, such as `MinhaEmpresa` or `https://minhaempresa.com.br/`.
 * @returns The canonical domain name, or a `SchemaError` that describes why the input is not a `.br` domain name.
 */
export const parseDomainNameInput = (input: string) => decodeDomainNameInput(input);
