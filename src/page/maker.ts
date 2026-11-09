import * as limits from "../../.limits/limits.json";
import type { Maker } from "../core/look-alike";

export const MAKER = (limits as { maker?: Maker }).maker;
