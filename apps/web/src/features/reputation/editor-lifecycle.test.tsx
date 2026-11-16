import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { PortfolioEditor } from "./portfolio-editor";
import { ReviewEditor } from "./review-editor";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
for (const kind of ["review", "portfolio"] as const)
  test(`a late ${kind} response must not close a newer editor after the original unmounted`, async () => {
    let settle = (_response: Response) => {};
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    let sent = false;
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      if (!init?.body) return Response.json({ services: [] });
      sent = true;
      return pending;
    }) as unknown as typeof fetch;
    const saved = mock(() => {});
    const id = "0198f5a0-7b1c-7000-8000-000000000001";
    const view = renderApp(
      kind === "review" ? (
        <ReviewEditor appointmentId={id} review={null} onSaved={saved} onDirtyChange={() => {}} />
      ) : (
        <PortfolioEditor
          photo={null}
          prepareFile={async () => "YWJj"}
          onSaved={saved}
          onDirtyChange={() => {}}
        />
      ),
    );
    if (kind === "review") {
      fireEvent.change(screen.getByLabelText("Public name"), { target: { value: "A." } });
      fireEvent.change(screen.getByLabelText("Your review"), { target: { value: "Lovely visit" } });
      fireEvent.click(
        screen.getByLabelText(
          "I agree to publish this name, rating and review on the salon website.",
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Send for moderation" }));
    } else {
      fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Finished style" } });
      fireEvent.change(screen.getByLabelText("Image description"), {
        target: { value: "Synthetic pixels" },
      });
      fireEvent.change(screen.getByLabelText("Photo file"), {
        target: { files: [new File(["fixture"], "photo.jpg", { type: "image/jpeg" })] },
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save private draft" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save private draft" }));
    }
    await waitFor(() => expect(sent).toBe(true));
    view.unmount();
    const at = "2026-03-02T12:00:00.000Z";
    const row =
      kind === "review"
        ? {
            id,
            appointmentId: id,
            publicName: "A.",
            body: "Lovely visit",
            rating: 5,
            shareServices: false,
            services: [],
            status: "pending",
            moderationReason: null,
            reply: null,
            version: 1,
            sourceEligible: true,
            createdAt: at,
            updatedAt: at,
          }
        : {
            id,
            caption: "Finished style",
            alt: "Synthetic pixels",
            serviceId: null,
            serviceName: null,
            width: 1,
            height: 1,
            bytes: 1,
            status: "draft",
            version: 1,
            createdAt: at,
            publishedAt: null,
          };
    await act(async () => {
      settle(Response.json(row, { status: 201 }));
    });
    await waitFor(() =>
      expect(view.queryClient.getMutationCache().getAll().at(-1)?.state.status).toBe("success"),
    );
    expect(saved).not.toHaveBeenCalled();
  });
