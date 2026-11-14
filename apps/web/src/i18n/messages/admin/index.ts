import { commonEn, commonEsAR } from "./common";

/** Dashboard catalogs: one file per area keeps `en` and `es-AR` side by side and type-checked. */
export const adminEn = { ...commonEn } as const;
export const adminEsAR: Record<keyof typeof adminEn, string> = { ...commonEsAR };
