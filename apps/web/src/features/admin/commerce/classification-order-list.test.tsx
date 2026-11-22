import { expect, mock, test } from "bun:test";
import type { InventoryClassification } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import {
  ClassificationOrderList,
  classificationDropTarget,
  classificationMoveProposal,
} from "./classification-order-list";

const rows: InventoryClassification[] = ["Apple", "Berry", "Cherry"].map((name, position) => ({
  id: crypto.randomUUID(),
  kind: "category",
  parentId: null,
  name,
  position,
  active: true,
  version: position + 1,
}));
const [first, second, third] = rows as [
  InventoryClassification,
  InventoryClassification,
  InventoryClassification,
];

test("drag targets use sibling midpoints and ignore positions outside the group", () => {
  const list = document.createElement("ul");
  list.getBoundingClientRect = () => new DOMRect(10, 20, 200, 150);
  for (const [index, entry] of rows.entries()) {
    const li = document.createElement("li");
    li.dataset.entry = entry.id;
    li.getBoundingClientRect = () => new DOMRect(10, 20 + index * 50, 200, 50);
    list.append(li);
  }
  expect(classificationDropTarget(list, first.id, 70, 125)).toEqual({ id: third.id, after: false });
  expect(classificationDropTarget(list, first.id, 70, 165)).toEqual({ id: third.id, after: true });
  expect(classificationDropTarget(list, first.id, 7, 125)).toBeNull();
  expect(classificationDropTarget(list, first.id, 70, 200)).toBeNull();
  expect(
    classificationMoveProposal(rows, "initial", first.id, { id: second.id, after: false }),
  ).toBeUndefined();
});

test("the keyboard handle and movement buttons use the same reviewed group", () => {
  const onMove = mock();
  renderApp(
    <ClassificationOrderList
      rows={rows}
      generation="initial"
      ready
      onMove={onMove}
      render={(entry, controls) => (
        <div>
          {entry.name}
          {controls}
        </div>
      )}
    />,
  );
  const handle = screen.getByRole("button", { name: "Drag to reorder Apple" });
  fireEvent.keyDown(handle, { key: "ArrowUp", altKey: true });
  expect(onMove).not.toHaveBeenCalled();
  fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Move Apple down" }));
  const proposal = classificationMoveProposal(rows, "initial", first.id, {
    id: second.id,
    after: true,
  });
  expect(onMove.mock.calls).toEqual([[proposal], [proposal]]);
});
