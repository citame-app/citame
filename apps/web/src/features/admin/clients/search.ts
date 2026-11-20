import { CLIENT_PAGE_SIZE_DEFAULT, type ClientListQuery, clientSortSchema } from "@sob/contracts";

export interface ClientsSearch {
  q?: string;
  group?: string;
  page: number;
  sort: ClientListQuery["sort"];
  order: ClientListQuery["order"];
}

/** URL search params of the clients list, sanitized: the URL is the table state. */
export function validateClientsSearch(raw: Record<string, unknown>): ClientsSearch {
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, 100) : "";
  const page = Number.parseInt(String(raw.page ?? "1"), 10);
  const sort = clientSortSchema.safeParse(raw.sort);
  return {
    ...(q ? { q } : {}),
    ...(typeof raw.group === "string" && raw.group.trim()
      ? { group: raw.group.trim().slice(0, 40) }
      : {}),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    sort: sort.success ? sort.data : "name",
    order: raw.order === "desc" ? "desc" : "asc",
  };
}

export function sortingToSearch(
  sorting: { id: string; desc: boolean }[],
): Pick<ClientsSearch, "sort" | "order" | "page"> {
  const first = sorting[0];
  const sort = clientSortSchema.safeParse(first?.id);
  if (!first || !sort.success) return { sort: "name", order: "asc", page: 1 };
  return { sort: sort.data, order: first.desc ? "desc" : "asc", page: 1 };
}

export function searchToQuery(search: ClientsSearch): ClientListQuery {
  return {
    ...(search.q ? { search: search.q } : {}),
    ...(search.group ? { tag: search.group } : {}),
    page: search.page,
    pageSize: CLIENT_PAGE_SIZE_DEFAULT,
    sort: search.sort,
    order: search.order,
  };
}
