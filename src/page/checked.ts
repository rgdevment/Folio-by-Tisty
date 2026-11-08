import { DOMAIN, proofOf, shardOf } from "../core/checked-domain";

declare const __FOLIO_SHARDS__: string[] | undefined;

export type ShardLoader = (shard: string) => Promise<unknown>;

const ASKED_FOR_AT_MOST_MS = 3000;
const BUILT_WITH = new Set(typeof __FOLIO_SHARDS__ === "undefined" ? [] : __FOLIO_SHARDS__);

const fromTheSite: ShardLoader = async (shard) =>
  (await fetch(`/domains/${shard}.json`, { signal: AbortSignal.timeout(ASKED_FOR_AT_MOST_MS) })).json();

export const isChecked = async (
  root: string,
  alias: string | undefined,
  load = fromTheSite,
  shards: ReadonlySet<string> = BUILT_WITH,
): Promise<boolean> => {
  if (alias === undefined || !DOMAIN.test(alias)) return false;
  try {
    const proof = await proofOf(root, alias);
    if (!shards.has(shardOf(proof))) return false;
    const held = await load(shardOf(proof));
    return Array.isArray(held) && held.includes(proof);
  } catch {
    return false;
  }
};
