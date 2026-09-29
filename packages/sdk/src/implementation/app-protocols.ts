/**
 * Host protocol adapters. A build records the protocol its `apps` framework speaks; the host runs
 * it only through that protocol's adapter. Each adapter owns the generated entry compiled into its
 * builds and converts between the host's current model and that protocol's messages. The current
 * protocol's adapter is the identity. A new protocol adds an adapter here; older ones stay.
 */
import { Effect } from "effect";
import type { HostInvocation, HostRequest } from "apps/contracts";
import type { SourceFile } from "../contracts/deployment.ts";
import { RuntimeProtocolUnsupported } from "../contracts/runtime.ts";
import { appBridge, nodeAppEntry } from "./worker-bridge.ts";

/** One released host protocol, seen from this host. */
export interface AppProtocol {
  readonly version: number;
  /** Server entry retained in this protocol's Worker builds. */
  readonly workerEntry: (files: readonly SourceFile[]) => string;
  /** Entry for the SDK's in-process Node runtime. */
  readonly nodeEntry: (files: readonly SourceFile[]) => string;
  /** Encode an invocation in the host's current model as this protocol's entry body. */
  readonly invocation: (input: HostInvocation) => string;
  /** Encode one current command for a bundle of this protocol. */
  readonly request: (command: HostRequest) => unknown;
  /**
   * Convert a bundle's reply to `command` into the host's current envelope. Transport fields
   * beside the envelope, such as telemetry, pass through unchanged.
   */
  readonly response: (command: HostRequest, body: unknown) => Effect.Effect<unknown>;
}

/** Protocol 1 is the host's current protocol, so its messages need no conversion. */
const protocol1: AppProtocol = {
  version: 1,
  workerEntry: appBridge,
  nodeEntry: nodeAppEntry,
  invocation: (input) => JSON.stringify(input),
  request: (command) => command,
  response: (_command, body) => Effect.succeed(body),
};

const protocols: ReadonlyMap<number, AppProtocol> = new Map([[protocol1.version, protocol1]]);

/** Protocols this host builds and runs. */
export const supportedProtocols: readonly number[] = [...protocols.keys()];

/** Select the adapter for a framework or retained build, before compiling or loading any code. */
export const appProtocol = (
  version: number,
): Effect.Effect<AppProtocol, RuntimeProtocolUnsupported> => {
  const protocol = protocols.get(version);
  return protocol === undefined
    ? Effect.fail(
        new RuntimeProtocolUnsupported({ protocol: version, supported: supportedProtocols }),
      )
    : Effect.succeed(protocol);
};
