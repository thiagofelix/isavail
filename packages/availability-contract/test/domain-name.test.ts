import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { parseDomainNameInput } from "../src/domain-name.ts";

describe("parseDomainNameInput", () => {
  it.effect("treats a bare company name as a .com.br domain", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* parseDomainNameInput("  MinhaEmpresa "), "minhaempresa.com.br");
    }),
  );

  it.effect("keeps the category the caller chose", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* parseDomainNameInput("minhaempresa.net.br"), "minhaempresa.net.br");
    }),
  );

  it.effect("removes a URL scheme, path, query, fragment, and trailing dot", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* parseDomainNameInput("https://MinhaEmpresa.com.br./contato?origem=busca#topo"),
        "minhaempresa.com.br",
      );
    }),
  );

  it.effect("composes accented letters into their canonical Unicode form", () =>
    Effect.gen(function* () {
      const decomposed = "ac\u0327ai\u0301.com.br";

      assert.strictEqual(yield* parseDomainNameInput(decomposed), "açaí.com.br");
    }),
  );

  it.effect("rejects domains outside .br", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseDomainNameInput("minhaempresa.com"));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects characters Registro.br never accepts", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseDomainNameInput("minha_empresa.com.br"));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects labels that start or end with a hyphen", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseDomainNameInput("-minhaempresa.com.br"));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
