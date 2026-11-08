import * as limits from "../../docs/limits.json";
import type { Maker } from "../core/look-alike";

export const MAKER = (limits as { maker?: Maker }).maker;
