import {
  type CalendarDate,
  DomainAvailability,
  type ReleaseWindow,
  type UnavailableReason,
} from "@isavail/availability-contract";
import { DateTime, Match, Option } from "effect";
import { DomainCheckFailure } from "../api/availability-http-api.ts";
import { DomainRow } from "./model.ts";

/**
 * How a row reads at a glance. `Available` can be registered now; `Contested`
 * can be requested but someone else may get it; `Unavailable` cannot be
 * registered now; `Pending` has no answer yet; `Problem` could not be checked.
 */
export type RowTone = "Available" | "Contested" | "Unavailable" | "Pending" | "Problem";

/** What a row shows. */
export interface RowPresentation {
  readonly tone: RowTone;
  readonly statusLabel: string;
  readonly maybeDetail: Option.Option<string>;
}

const BRASILIA_DATE_TIME = {
  locale: "pt-BR",
  timeZone: "America/Sao_Paulo",
  dateStyle: "short",
  timeStyle: "short",
} as const;

const formatBrasiliaDateTime = DateTime.format(BRASILIA_DATE_TIME);

const formatCalendarDate = (date: CalendarDate): string => {
  const [year = "", month = "", day = ""] = date.split("-");

  return `${day}/${month}/${year}`;
};

const describeWindow = ({ startsAt, endsAt }: ReleaseWindow): string =>
  `de ${formatBrasiliaDateTime(startsAt)} a ${formatBrasiliaDateTime(endsAt)}, horário de Brasília`;

const describeCompetingTickets = (count: number): string =>
  count === 1
    ? "Já existe 1 pedido de registro concorrente; o Registro.br decide entre os pedidos."
    : `Já existem ${count} pedidos de registro concorrentes; o Registro.br decide entre os pedidos.`;

const unavailableLabel = (reason: UnavailableReason): string =>
  Match.value(reason).pipe(
    Match.withReturnType<string>(),
    Match.when("Reserved", () => "Reservado"),
    Match.when("InvalidDomain", () => "Nome não aceito"),
    Match.when("InvalidCategory", () => "Categoria inexistente"),
    Match.when("Other", () => "Indisponível"),
    Match.exhaustive,
  );

const presentAvailability = (availability: DomainAvailability): RowPresentation =>
  DomainAvailability.match<RowPresentation>(availability, {
    Available: () => ({
      tone: "Available",
      statusLabel: "Disponível",
      maybeDetail: Option.some("Ninguém registrou nem pediu este domínio."),
    }),
    AvailableWithCompetingTickets: ({ competingTicketCount }) => ({
      tone: "Contested",
      statusLabel: "Disponível, com concorrência",
      maybeDetail: Option.some(describeCompetingTickets(competingTicketCount)),
    }),
    Registered: ({ expiry }) => ({
      tone: "Unavailable",
      statusLabel: "Registrado",
      maybeDetail: Option.some(
        expiry._tag === "ExpiresOn"
          ? `O registro atual vence em ${formatCalendarDate(expiry.date)}.`
          : "O titular é isento de renovação.",
      ),
    }),
    Unavailable: ({ reason, registryMessage }) => ({
      tone: "Unavailable",
      statusLabel: unavailableLabel(reason),
      maybeDetail: Option.some(`Motivo informado pelo Registro.br: ${registryMessage}.`),
    }),
    AwaitingRelease: () => ({
      tone: "Unavailable",
      statusLabel: "Aguardando liberação",
      maybeDetail: Option.some(
        "O registro anterior terminou e o Registro.br ainda não abriu o processo de liberação.",
      ),
    }),
    ReleaseInProgress: ({ window, competingTicketCount }) => ({
      tone: "Contested",
      statusLabel: "Em liberação",
      maybeDetail: Option.some(
        `Aceita pedidos ${describeWindow(window)}.${competingTicketCount > 0 ? ` ${describeCompetingTickets(competingTicketCount)}` : ""}`,
      ),
    }),
    CompetitiveReleaseInProgress: ({ acceptingTicketsUntil, competingTicketCount }) => ({
      tone: "Contested",
      statusLabel: "Liberação competitiva",
      maybeDetail: Option.some(
        `Aceita novos pedidos até ${formatBrasiliaDateTime(acceptingTicketsUntil)}, horário de Brasília. ${describeCompetingTickets(competingTicketCount)}`,
      ),
    }),
  });

const describeFailure = (failure: DomainCheckFailure): string =>
  DomainCheckFailure.match(failure, {
    RegistryRateLimited: ({ retryAfterSeconds }) =>
      `O Registro.br limita consultas seguidas. Tente de novo em ${retryAfterSeconds} s.`,
    RegistryUnreachable: () => "O Registro.br não respondeu a tempo. Tente de novo.",
    RegistryResponseUnreadable: () =>
      "O Registro.br respondeu num formato inesperado. Tente de novo.",
    RegistryFailed: ({ registryMessage }) =>
      `O Registro.br recusou a consulta: ${registryMessage}. Tente de novo em instantes.`,
    LookupServiceUnavailable: () =>
      "O serviço que consulta o Registro.br está fora do ar. Tente de novo em instantes.",
  });

/**
 * Describes a row in Portuguese.
 *
 * @param row - The row to describe.
 * @returns Its tone, a short status label, and an optional sentence of detail.
 */
export const presentRow = (row: DomainRow): RowPresentation =>
  DomainRow.match<RowPresentation>(row, {
    Checking: () => ({
      tone: "Pending",
      statusLabel: "Verificando…",
      maybeDetail: Option.none(),
    }),
    Checked: ({ availability }) => presentAvailability(availability),
    WaitingForRegistryBudget: ({ retryAfterSeconds }) => ({
      tone: "Pending",
      statusLabel: "Na fila",
      maybeDetail: Option.some(
        `O Registro.br responde poucas consultas seguidas. Nova tentativa automática em ${retryAfterSeconds} s.`,
      ),
    }),
    NotChecked: ({ failure }) => ({
      tone: "Problem",
      statusLabel: "Não verificado",
      maybeDetail: Option.some(describeFailure(failure)),
    }),
    RequestFailed: () => ({
      tone: "Problem",
      statusLabel: "Não verificado",
      maybeDetail: Option.some(
        "Não foi possível falar com o serviço de consulta. Confira sua conexão e tente de novo.",
      ),
    }),
  });

/**
 * When the answer shown was given, for a row that has one.
 *
 * @returns The answer time in Brasília time, marked when it was reused from a recent check.
 */
export const describeCheckedAt = (row: DomainRow): Option.Option<string> =>
  row._tag === "Checked"
    ? Option.some(
        `${row.servedFromCache ? "Consulta recente reaproveitada" : "Consultado"} em ${formatBrasiliaDateTime(row.checkedAt)}`,
      )
    : Option.none();
