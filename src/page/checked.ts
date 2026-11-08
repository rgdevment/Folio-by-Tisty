import { DOMAIN, proofOf, shardOf } from "../core/checked-domain";

export type ShardLoader = (shard: string) => Promise<unknown>;

const fromTheSite: ShardLoader = async (shard) => (await fetch(`/domains/${shard}.json`)).json();

export const isChecked = async (root: string, alias: string | undefined, load = fromTheSite): Promise<boolean> => {
  if (alias === undefined || !DOMAIN.test(alias)) return false;
  try {
    const proof = await proofOf(root, alias);
    const held = await load(shardOf(proof));
    return Array.isArray(held) && held.includes(proof);
  } catch {
    return false;
  }
};
