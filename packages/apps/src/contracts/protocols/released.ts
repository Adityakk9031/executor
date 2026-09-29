/** Every released host protocol. `bun run check` compares each with its committed snapshot. */
import { protocol1 } from "./1.ts";
import { protocol2 } from "./2.ts";

export const releasedProtocols = [protocol1, protocol2] as const;
