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

/** Protocol 3 is the host's current protocol, so its messages need no conversion. */
const protocol3: AppProtocol = {
  version: 3,
  workerEntry: appBridge,
  nodeEntry: nodeAppEntry,
  invocation: (input) => JSON.stringify(input),
  request: (command) => command,
  response: (_command, body) => Effect.succeed(body),
};

/**
 * Protocol 2 has the same requests and entry. Its failures lack protocol 3's optional failure
 * detail, so every protocol 2 reply is already a protocol 3 reply without that detail. Protocol 2
 * bundles ignore the detail in workflow step replies.
 */
const protocol2: AppProtocol = { ...protocol3, version: 2 };

/**
 * Protocol 1 differs from protocol 2 only in its skill catalog reply, which never says whether a
 * loader read through the app cache. That reply is already a valid protocol 2 reply whose loader
 * did not, so its messages need no conversion either.
 */
const protocol1: AppProtocol = { ...protocol3, version: 1 };

const protocols: ReadonlyMap<number, AppProtocol> = new Map(
  [protocol1, protocol2, protocol3].map((protocol) => [protocol.version, protocol]),
);

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
