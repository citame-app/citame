import { calendarEn, calendarEsAR } from "./calendar";
import { calendarUiEn, calendarUiEsAR } from "./calendar-ui";
import { clientsEn, clientsEsAR } from "./clients";
import { commonEn, commonEsAR } from "./common";
import { drawerEn, drawerEsAR } from "./drawer";
import { reportsEn, reportsEsAR } from "./reports";
import { resourcesEn, resourcesEsAR } from "./resources";
import { servicesEn, servicesEsAR } from "./services";
import { settingsEn, settingsEsAR } from "./settings";
import { staffEn, staffEsAR } from "./staff";
import { todayEn, todayEsAR } from "./today";
import { walkinEn, walkinEsAR } from "./walkin";
// @@imports

/** Dashboard catalogs: one file per area keeps `en` and `es-AR` side by side and type-checked. */
export const adminEn = {
  ...commonEn,
  ...calendarEn,
  ...calendarUiEn,
  ...todayEn,
  ...walkinEn,
  ...drawerEn,
  ...clientsEn,
  ...servicesEn,
  ...resourcesEn,
  ...staffEn,
  ...reportsEn,
  ...settingsEn,
  // @@en
} as const;
export const adminEsAR: Record<keyof typeof adminEn, string> = {
  ...commonEsAR,
  ...calendarEsAR,
  ...calendarUiEsAR,
  ...todayEsAR,
  ...walkinEsAR,
  ...drawerEsAR,
  ...clientsEsAR,
  ...servicesEsAR,
  ...resourcesEsAR,
  ...staffEsAR,
  ...reportsEsAR,
  ...settingsEsAR,
  // @@es
};
