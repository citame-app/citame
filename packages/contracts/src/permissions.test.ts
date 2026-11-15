import { expect, test } from "bun:test";
import { permissionsFor } from "./permissions";

test("owner keeps account and settings control, managers get operational permissions", () => {
  expect(permissionsFor("owner").manageAccounts).toBe(true);
  expect(permissionsFor("staff", "manager")).toMatchObject({
    allCalendars: true,
    editSchedules: true,
    financialReports: true,
    writeInventory: true,
    readCosts: true,
    manageCommissions: true,
    manageAccounts: false,
    manageSettings: false,
  });
});
test("reception can run bookings and the register without cost or commission administration", () => {
  expect(permissionsFor("staff", "receptionist")).toMatchObject({
    allCalendars: true,
    editCalendar: true,
    allSales: true,
    commerce: true,
    manageCash: true,
    financialReports: false,
    readCosts: false,
    manageCommissions: false,
  });
});
test("professional defaults to own calendars and sales, restricted access is read-only", () => {
  expect(permissionsFor("staff")).toMatchObject({
    allCalendars: false,
    editCalendar: true,
    commerce: true,
    allSales: false,
    manageCash: false,
  });
  expect(permissionsFor("staff", "restricted")).toMatchObject({
    editCalendar: false,
    commerce: false,
    clients: false,
    readInventory: false,
    operationalReports: false,
  });
  expect(Object.values(permissionsFor("client")).every((value) => value === false)).toBe(true);
});
