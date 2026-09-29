/** Every released host protocol. `bun run check` compares each with its committed snapshot. */
import { protocol1 } from "./1.ts";

export const releasedProtocols = [protocol1] as const;
