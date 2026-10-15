/**
 * Runs isavail for development: the server under `node --watch` (restarted on
 * every source change) and Vite, which serves the website with hot reload and
 * forwards `/v1` to the server. Stops both when either exits or on Ctrl-C.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { ChildProcess } from "effect/process";

const untilExit = (command: ChildProcess.Command) =>
  Effect.scoped(Effect.flatMap(command, (handle) => handle.exitCode));

const server = ChildProcess.make("node", ["--watch", "src/server/main.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});

const website = ChildProcess.make("vp", ["dev"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

Effect.raceFirst(untilExit(server), untilExit(website)).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
