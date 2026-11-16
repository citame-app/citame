import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ClientPhotos } from "./client-photos";

const CLIENT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const PHOTO = "0198f5a0-7b1c-7000-8000-0000000000a1";
const originalFetch = globalThis.fetch;
const existing = {
  id: PHOTO,
  clientId: CLIENT,
  caption: "Before colour",
  capturedOn: "2026-03-01",
  width: 300,
  height: 200,
  bytes: 1000,
  version: 1,
  createdAt: "2026-03-02T12:00:00.000Z",
  updatedAt: "2026-03-02T12:00:00.000Z",
};
let photos: (typeof existing)[];
let writes: { method: string; body: Record<string, unknown>; path: string }[];
let fail: "none" | "network" | "stale" | "capacity";
let readError: boolean;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  photos = [];
  writes = [];
  fail = "none";
  readError = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (method === "GET")
      return readError
        ? json({ error: { code: "internal_error", message: "Temporary read failure" } }, 500)
        : json({ photos, canEdit: true, limit: 20 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    writes.push({ method, body, path: `${url.pathname}${url.search}` });
    if (fail === "network") {
      fail = "none";
      throw new TypeError("Connection lost");
    }
    if (fail === "stale")
      return json({ error: { code: "version_conflict", message: "Changed" } }, 409);
    if (fail === "capacity")
      return json({ error: { code: "storage_limit", message: "Full" } }, 409);
    if (method === "DELETE") {
      photos = [];
      return json({ id: PHOTO, deleted: true });
    }
    const saved = {
      ...existing,
      caption: body.caption,
      capturedOn: body.capturedOn ?? null,
      version: method === "PATCH" ? 2 : 1,
    };
    photos = [saved];
    return json(saved, method === "POST" ? 201 : 200);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const open = () =>
  renderApp(<ClientPhotos clientId={CLIENT} prepareFile={async () => "aGVsbG8="} />);

test("a private photo requires an image, caption and explicit permission before upload", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Add private photo" }));
  const submit = screen.getByRole("button", { name: "Save photo" });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Choose photo"), {
    target: { files: [new File(["fixture"], "photo.jpg", { type: "image/jpeg" })] },
  });
  fireEvent.change(screen.getByLabelText("Photo description"), {
    target: { value: "Before colour" },
  });
  await screen.findByRole("img", { name: "Photo preview" });
  expect(submit).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I have permission to store this photo in the private client record.",
    }),
  );
  fireEvent.click(submit);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toMatchObject({
    permissionConfirmed: true,
    caption: "Before colour",
    imageBase64: "aGVsbG8=",
  });
  expect(writes[0]?.body).not.toHaveProperty("filename");
});

test("an uncertain upload response preserves the image and upload identifier for retry", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Add private photo" }));
  fireEvent.change(screen.getByLabelText("Choose photo"), {
    target: { files: [new File(["fixture"], "photo.jpg", { type: "image/jpeg" })] },
  });
  fireEvent.change(screen.getByLabelText("Photo description"), {
    target: { value: "Before colour" },
  });
  await screen.findByRole("img", { name: "Photo preview" });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I have permission to store this photo in the private client record.",
    }),
  );
  fail = "network";
  readError = true;
  fireEvent.click(screen.getByRole("button", { name: "Save photo" }));
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(screen.getByLabelText("Photo description")).toHaveValue("Before colour"),
  );
  readError = false;
  expect(screen.getByLabelText("Photo description")).toHaveValue("Before colour");
  fireEvent.click(screen.getByRole("button", { name: "Save photo" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
});

test("a stale photo edit retains the draft and deletion needs explicit confirmation", async () => {
  photos = [existing];
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Open photo: Before colour" }));
  fireEvent.change(screen.getByLabelText("Photo description"), {
    target: { value: "After colour" },
  });
  fail = "stale";
  fireEvent.click(screen.getByRole("button", { name: "Save photo" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Photo description")).toHaveValue("After colour");
  expect(screen.getByRole("button", { name: "Save photo" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload photo details" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Photo description")).toHaveValue("Before colour"),
  );
  fail = "none";
  fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
  expect(writes.filter((w) => w.method === "DELETE")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Permanently remove photo" }));
  await waitFor(() => expect(writes.filter((w) => w.method === "DELETE")).toHaveLength(1));
  expect(writes.find((w) => w.method === "DELETE")?.path).toContain("version=1");
});

test("storage capacity is explained while preserving the selected image and description", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Add private photo" }));
  fireEvent.change(screen.getByLabelText("Choose photo"), {
    target: { files: [new File(["fixture"], "photo.jpg", { type: "image/jpeg" })] },
  });
  fireEvent.change(screen.getByLabelText("Photo description"), {
    target: { value: "Before colour" },
  });
  await screen.findByRole("img", { name: "Photo preview" });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I have permission to store this photo in the private client record.",
    }),
  );
  fail = "capacity";
  fireEvent.click(screen.getByRole("button", { name: "Save photo" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/photo storage is full/i);
  expect(screen.getByLabelText("Photo description")).toHaveValue("Before colour");
  expect(screen.getByRole("img", { name: "Photo preview" })).toBeInTheDocument();
});
