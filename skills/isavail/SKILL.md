---
name: isavail
description: Check whether Brazilian .br domains can be registered, through the isavail HTTP API at https://isavail.home.thiagofelix.com/v1 (backed by Registro.br's official ISAVAIL service). Use whenever a task involves .br domain availability, such as naming a company, product or brand for Brazil, shortlisting domain names, validating that a .com.br is free, or building a feature that calls this API. Not for non-.br TLDs.
---

# isavail: .br domain availability

The base URL is `https://isavail.home.thiagofelix.com/v1`. The OpenAPI 3.1 spec is at `/v1/openapi.json`. The API needs no auth and no API key, and every answer comes from Registro.br.

## Endpoints

| Method and path                      | Use                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `POST /v1/availability-checks`       | Checks 1 to 50 names. Body: `{"domains": [...]}`. Send `Content-Type: application/json` or you get a 415. |
| `GET /v1/domains/{domain}/availability` | Checks one name and returns the same report shape with one check.                      |
| `GET /v1/health`                     | Returns 204 when the service is up. It does not use any of the registry budget.           |

```sh
curl -s -X POST https://isavail.home.thiagofelix.com/v1/availability-checks \
  -H 'content-type: application/json' \
  -d '{"domains":["minhaempresa","minhaempresa.net.br","minha-empresa.com.br"]}'

curl -s https://isavail.home.thiagofelix.com/v1/domains/minhaempresa/availability
```

## Input rules

- A bare name means `.com.br`, so `minhaempresa` is checked as `minhaempresa.com.br`.
- A full domain has to end in `.br`. Any category works, such as `.net.br`, `.app.br`, `.dev.br`, `.ia.br` or `.tec.br`.
- The API lowercases input, so `GOOGLE.com.br` is fine. Accented letters are allowed (`açaí-brasil`), and so are hyphens.
- Spaces, `foo.com`, `a..b` and anything else that isn't a .br name get a **400 `InvalidDomainNames`** response. **The whole batch is rejected and nothing is checked.** Read `details.violations[].input` to find the bad entries, then fix or remove them and resend. Slugify company names yourself first: lowercase them, turn spaces into `-` or remove them, and strip punctuation.
- An empty `domains` array gets a 400 with no body.
- Send IDNs in Unicode form (`café`), not punycode. `xn--…` input is accepted, but today it comes back `NotChecked`/`RegistryUnreachable`.
- Entries that normalize to the same domain are checked once. Match results by `checks[].domainName`, never by array index.

## Reading the response

```jsonc
{ "requestId": "req_…", "checks": [ /* one per distinct domain */ ] }
```

Each check is one of two shapes:

- `{"_tag":"Checked", domainName, availability, checkedAt, servedFromCache}`
- `{"_tag":"NotChecked", domainName, failure}`

Branch on `availability._tag`:

| `availability._tag`            | Can register now?   | Extra fields                                                         |
| ------------------------------ | ------------------- | -------------------------------------------------------------------- |
| `Available`                    | **Yes**             | none                                                                 |
| `AvailableWithCompetingTickets`| **Yes**, but others already filed tickets | `competingTicketCount`              |
| `ReleaseInProgress`            | Only by opening a ticket inside the window | `window.{startsAt,endsAt}`, `competingTicketCount` |
| `CompetitiveReleaseInProgress` | Only by opening a ticket before the deadline | `window`, `acceptingTicketsUntil`, `competingTicketCount` |
| `AwaitingRelease`              | No, it will be released later | none                                                       |
| `Registered`                   | No                  | `expiry` (`{"_tag":"ExpiresOn","date":"YYYY-MM-DD"}` or `{"_tag":"ExemptFromPayment"}`), `publicationStatus`, `nameservers`, `suggestedAlternatives` |
| `Unavailable`                  | No                  | `reason`, `registryMessage`, `suggestedAlternatives`                 |

`Unavailable.reason` has four values:

- `Reserved`: the word is reserved, for example `"Word is reserved by CG"`.
- `InvalidDomain`: the registry rejected the name, for example a single letter like `a.com.br`.
- `InvalidCategory`: the category doesn't exist, for example `.foo.br`.
- `Other`: read `registryMessage`. A common one is `"Domain with similar sintax already registered"`. Registro.br treats accented and unaccented spellings as the same name, so `café.com.br` is blocked when `cafe.com.br` is taken.

`suggestedAlternatives` lists the same label under other categories that Registro.br accepts. **It does not say whether they are free.** Check them before you recommend one.

`servedFromCache: true` means the answer is reused from a recent check. Cache lifetimes are about 5 min for available names, 15 to 30 min for names being released, 6 h for registered names and 24 h for unavailable ones. Treat `Available` as a strong hint, not a reservation.

## Rate limits and retries (important)

Registro.br allows a burst of about 30 queries, then about 1 per second. That budget is **shared by every caller of this service**. Each request spends at most about 5 seconds waiting for budget. Domains it can't fit in come back as:

```json
{"_tag":"NotChecked","domainName":"x.com.br","failure":{"_tag":"RegistryRateLimited","retryAfterSeconds":1}}
```

`failure._tag` has four values:

- `RegistryRateLimited`: wait `retryAfterSeconds`, then resend **only those domains**.
- `RegistryUnreachable` or `RegistryResponseUnreadable`: a transient registry problem. Retry a few times with backoff.
- `RegistryFailed`: the registry reported an error. Read `registryMessage`. Retrying probably won't help.

Rules of thumb:

- Prefer batches of 25 or fewer. A batch of 50 nearly always comes back partly `NotChecked`.
- Never treat `NotChecked` as unavailable. Retry it, or report it as unknown.
- Cached answers cost no budget, so re-checking a shortlist is cheap.
- Don't poll `/availability` as a health check. Use `/v1/health`.

## Retry loop (TypeScript)

```ts
const BASE = "https://isavail.home.thiagofelix.com/v1";

type Check =
  | { _tag: "Checked"; domainName: string; availability: { _tag: string; [k: string]: unknown }; checkedAt: string; servedFromCache: boolean }
  | { _tag: "NotChecked"; domainName: string; failure: { _tag: string; retryAfterSeconds?: number; registryMessage?: string } };

export async function checkAll(names: string[], maxRounds = 6): Promise<Map<string, Check>> {
  const results = new Map<string, Check>();
  let pending = [...new Set(names)];
  for (let round = 0; pending.length > 0 && round < maxRounds; round++) {
    const retry: string[] = [];
    let waitSeconds = 0;
    for (let i = 0; i < pending.length; i += 25) {
      const res = await fetch(`${BASE}/availability-checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domains: pending.slice(i, i + 25) }),
      });
      if (res.status === 400) throw new Error(`Invalid names: ${JSON.stringify((await res.json()).details?.violations)}`);
      if (!res.ok) throw new Error(`isavail ${res.status}`);
      const { checks } = (await res.json()) as { checks: Check[] };
      for (const check of checks) {
        results.set(check.domainName, check);
        if (check._tag === "NotChecked" && check.failure._tag !== "RegistryFailed") {
          retry.push(check.domainName); // normalized name, safe to resend
          waitSeconds = Math.max(waitSeconds, check.failure.retryAfterSeconds ?? 2 ** round);
        }
      }
    }
    pending = retry;
    if (pending.length) await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  }
  return results; // anything still NotChecked is unknown, not unavailable
}

export const canRegisterNow = (c: Check) =>
  c._tag === "Checked" && (c.availability._tag === "Available" || c.availability._tag === "AvailableWithCompetingTickets");
```

The results map is keyed by the normalized `domainName` (lowercase, with `.com.br` appended to bare names), so normalize your own keys the same way before you look them up.

## Workflow for naming tasks

1. Generate candidate labels and slugify them (lowercase ASCII or Portuguese accents, letters, digits and hyphens).
2. POST them in batches of 25 or fewer, mixing categories if wanted (`nome`, `nome.app.br`, `nome.ia.br`).
3. Keep `Available` and `AvailableWithCompetingTickets`. Mention ticket counts and release windows when they come up.
4. For names that are taken, optionally check a few of their `suggestedAlternatives`.
5. Retry `NotChecked` as described above. Report anything still unresolved as "couldn't verify".
6. Quote `requestId` when reporting a problem with the service.
