import type { DomainName } from "../domain/domain-name.ts";
import { Button, Textarea } from "@foldkit/ui";
import { Array, Option, pipe } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { OPENAPI_PATH } from "../api/availability-http-api.ts";
import { MAX_ENTRIES_PER_SUBMISSION } from "./main.ts";
import { Message } from "./message.ts";
import { DomainRow, EntryFeedback, type Model } from "./model.ts";
import { describeCheckedAt, presentRow, type RowTone } from "./presentation.ts";

const ENTRIES_FIELD_ID = "domain-entries";
const RESULTS_HEADING_ID = "results-heading";

const registroBrSearchUrl = (domainName: DomainName): string =>
  `https://registro.br/busca-dominio/?fqdn=${encodeURIComponent(domainName)}`;

const suggestedAlternativesOf = (row: DomainRow): ReadonlyArray<DomainName> =>
  row._tag === "Checked" &&
  (row.availability._tag === "Registered" || row.availability._tag === "Unavailable")
    ? row.availability.suggestedAlternatives
    : [];

const canBeRequested = (tone: RowTone): boolean => tone === "Available" || tone === "Contested";

// FORM

const entryFeedbackView = (entryFeedback: EntryFeedback, h: HtmlBuilder<Message>): Html =>
  EntryFeedback.match(entryFeedback, {
    Accepted: () => h.empty,
    NoEntries: () =>
      h.p([h.Class("form-feedback"), h.Role("alert")], ["Digite ao menos um nome ou domínio."]),
    TooManyEntries: ({ count }) =>
      h.p(
        [h.Class("form-feedback"), h.Role("alert")],
        [
          `Você enviou ${count} itens. Envie até ${MAX_ENTRIES_PER_SUBMISSION} por vez para não esgotar a cota de consultas do Registro.br.`,
        ],
      ),
    RejectedEntries: ({ entries }) =>
      h.div(
        [h.Class("form-feedback"), h.Role("alert")],
        [
          h.p(
            [],
            [
              "Estes itens não são domínios .br e não foram verificados. Use letras, números e hífens, como minhaempresa ou minhaempresa.net.br:",
            ],
          ),
          h.ul(
            [h.Class("rejected-entries")],
            Array.map(entries, (entry) => h.li([], [h.code([], [entry])])),
          ),
        ],
      ),
  });

const checkFormView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class("check-form"), h.OnSubmit(Message.SubmittedCheckForm())],
    [
      Textarea.view(
        {
          id: ENTRIES_FIELD_ID,
          value: model.entriesInput,
          rows: 5,
          hasDescription: true,
          isInvalid: model.entryFeedback._tag !== "Accepted",
          placeholder: "minhaempresa\nminhaempresa.net.br\nminha-empresa.com.br",
          onInput: (value) => Message.UpdatedEntriesInput({ value }),
          toView: (attributes) =>
            h.div(
              [h.Class("field")],
              [
                h.label([...attributes.label, h.Class("field-label")], ["Nomes ou domínios"]),
                h.p(
                  [...attributes.description, h.Class("field-description")],
                  [
                    `Um por linha, ou separados por vírgula. Nomes sem categoria são verificados como .com.br. Até ${MAX_ENTRIES_PER_SUBMISSION} por vez.`,
                  ],
                ),
                h.div(
                  [h.Class("textarea-frame")],
                  [
                    h.textarea([
                      ...attributes.textarea,
                      h.Class("field-textarea"),
                      h.Spellcheck(false),
                      h.Autocapitalize("off"),
                    ]),
                  ],
                ),
              ],
            ),
        },
        h,
      ),
      entryFeedbackView(model.entryFeedback, h),
      Button.view(
        {
          type: "submit",
          toView: (attributes) =>
            h.button(
              [...attributes.button, h.Class("primary-button")],
              [h.span([], ["Verificar disponibilidade"])],
            ),
        },
        h,
      ),
    ],
  );

// RESULTS

const suggestionsView = (
  suggestedAlternatives: ReadonlyArray<DomainName>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.isReadonlyArrayEmpty(suggestedAlternatives)
    ? h.empty
    : h.div(
        [h.Class("suggestions")],
        [
          h.p([h.Class("suggestions-label")], ["O Registro.br sugere o mesmo nome em:"]),
          h.ul(
            [h.Class("suggestion-list")],
            Array.map(suggestedAlternatives, (domainName) =>
              h.keyed("li")(
                domainName,
                [],
                [
                  Button.view(
                    {
                      onClick: Message.ClickedSuggestedAlternative({ domainName }),
                      toView: (attributes) =>
                        h.button(
                          [...attributes.button, h.Class("suggestion-button")],
                          [h.span([], [domainName])],
                        ),
                    },
                    h,
                  ),
                ],
              ),
            ),
          ),
        ],
      );

const rowActionsView = (row: DomainRow, tone: RowTone, h: HtmlBuilder<Message>): Html => {
  if (canBeRequested(tone)) {
    return h.a(
      [
        h.Class("row-action"),
        h.Href(registroBrSearchUrl(row.domainName)),
        h.Target("_blank"),
        h.Rel("noopener noreferrer"),
      ],
      ["Registrar no Registro.br"],
    );
  } else if (tone === "Problem") {
    return Button.view(
      {
        onClick: Message.ClickedRecheckDomain({ domainName: row.domainName }),
        toView: (attributes) =>
          h.button(
            [...attributes.button, h.Class("row-action")],
            [h.span([], ["Verificar de novo"])],
          ),
      },
      h,
    );
  } else {
    return h.empty;
  }
};

const resultRowView = (row: DomainRow, h: HtmlBuilder<Message>): Html => {
  const { tone, statusLabel, maybeDetail } = presentRow(row);

  return h.keyed("li")(
    row.domainName,
    [h.Class("result"), h.DataAttribute("tone", tone)],
    [
      h.div(
        [h.Class("result-heading")],
        [
          h.span([h.Class("result-domain")], [row.domainName]),
          h.span([h.Class("status-badge")], [statusLabel]),
        ],
      ),
      Option.match(maybeDetail, {
        onNone: () => h.empty,
        onSome: (detail) => h.p([h.Class("result-detail")], [detail]),
      }),
      Option.match(describeCheckedAt(row), {
        onNone: () => h.empty,
        onSome: (checkedAt) => h.p([h.Class("result-checked-at")], [checkedAt]),
      }),
      suggestionsView(suggestedAlternativesOf(row), h),
      rowActionsView(row, tone, h),
    ],
  );
};

const countTone = (rows: ReadonlyArray<DomainRow>, tone: RowTone): number =>
  Array.filter(rows, (row) => presentRow(row).tone === tone).length;

const summaryText = (rows: ReadonlyArray<DomainRow>): string =>
  pipe(
    [
      [countTone(rows, "Available"), "disponível", "disponíveis"],
      [countTone(rows, "Contested"), "disputado", "disputados"],
      [countTone(rows, "Unavailable"), "indisponível", "indisponíveis"],
      [countTone(rows, "Pending"), "em andamento", "em andamento"],
      [countTone(rows, "Problem"), "não verificado", "não verificados"],
    ] satisfies ReadonlyArray<readonly [number, string, string]>,
    Array.filter(([count]) => count > 0),
    Array.map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`),
    Array.join(" · "),
  );

const resultsView = (rows: ReadonlyArray<DomainRow>, h: HtmlBuilder<Message>): Html =>
  Array.isReadonlyArrayEmpty(rows)
    ? h.empty
    : h.section(
        [h.Class("results"), h.AriaLabelledBy(RESULTS_HEADING_ID)],
        [
          h.div(
            [h.Class("results-heading")],
            [
              h.h2([h.Id(RESULTS_HEADING_ID)], ["Resultado"]),
              h.p([h.Class("results-summary"), h.Role("status")], [summaryText(rows)]),
            ],
          ),
          h.ul(
            [h.Class("result-list"), h.AriaLive("polite")],
            Array.map(rows, (row) => resultRowView(row, h)),
          ),
        ],
      );

// PAGE

const agentsView = (h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class("agents")],
    [
      h.h2([], ["Para agentes de IA e integrações"]),
      h.p(
        [],
        [
          "Envie ",
          h.code([], ['POST /v1/availability-checks {"domains": ["minhaempresa"]}']),
          " ou ",
          h.code([], ["GET /v1/domains/minhaempresa.com.br/availability"]),
          ". O contrato completo está em ",
          h.a([h.Href(OPENAPI_PATH)], [OPENAPI_PATH]),
          ".",
        ],
      ),
    ],
  );

/** Renders the page. */
// oxlint-disable-next-line effecttsgo/missing-pipeable-signature -- Foldkit's runtime calls view(model, h).
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "isavail — disponibilidade de domínios .br",
  body: h.div(
    [h.Class("page")],
    [
      h.header(
        [h.Class("masthead")],
        [
          h.h1([], ["Quais nomes ainda estão livres?"]),
          h.p(
            [h.Class("lede")],
            [
              "Cole os nomes que você está considerando para a empresa. Cada um é consultado no serviço oficial de disponibilidade do Registro.br.",
            ],
          ),
        ],
      ),
      h.main([h.Class("workspace")], [checkFormView(model, h), resultsView(model.rows, h)]),
      agentsView(h),
    ],
  ),
});
