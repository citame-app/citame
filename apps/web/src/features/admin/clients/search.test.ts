import { describe, expect, test } from "bun:test";
import { searchToQuery, sortingToSearch, validateClientsSearch } from "./search";

describe("validateClientsSearch", () => {
  test("fills defaults", () => {
    expect(validateClientsSearch({})).toEqual({ page: 1, sort: "name", order: "asc" });
  });

  test("keeps valid values and drops junk", () => {
    expect(
      validateClientsSearch({ q: " ana ", page: "3", sort: "lastVisitAt", order: "desc" }),
    ).toEqual({
      q: "ana",
      page: 3,
      sort: "lastVisitAt",
      order: "desc",
    });
    expect(validateClientsSearch({ page: "-4", sort: "email", order: "up", q: "" })).toEqual({
      page: 1,
      sort: "name",
      order: "asc",
    });
  });
});

describe("sortingToSearch", () => {
  test("maps the table sorting state to the sort params and resets to page 1", () => {
    expect(sortingToSearch([{ id: "lastVisitAt", desc: true }])).toEqual({
      sort: "lastVisitAt",
      order: "desc",
      page: 1,
    });
    expect(sortingToSearch([])).toEqual({ sort: "name", order: "asc", page: 1 });
    expect(sortingToSearch([{ id: "phone", desc: false }])).toEqual({
      sort: "name",
      order: "asc",
      page: 1,
    });
  });
});

describe("searchToQuery", () => {
  test("builds the API query with the fixed page size", () => {
    expect(searchToQuery({ q: "ana", page: 2, sort: "name", order: "desc" })).toEqual({
      search: "ana",
      page: 2,
      pageSize: 20,
      sort: "name",
      order: "desc",
    });
  });
});
