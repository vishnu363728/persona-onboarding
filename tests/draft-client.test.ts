import test from "node:test";
import assert from "node:assert/strict";
import { mountUI } from "./persona-ui-fixture";

test("saved draft survives StrictMode effect replay, edits, and a reload", () => {
  const originalDraft = "Line one\nLine two\nNot sent yet";
  const storage = new Map([["persona-draft", originalDraft]]);
  let component = mountUI({ storage });
  try {
    component.render();
    component.commit();
    component.replayMount();
    assert.equal(storage.get("persona-draft"), originalDraft);
    assert.deepEqual(
      component.writes,
      [],
      "the initial empty state must never overwrite storage",
    );
    component.render();
    component.commit();
    assert.equal(component.textarea()?.props.value, originalDraft);
    component.textarea()?.props.onChange?.({
      target: { value: originalDraft + "\nMore detail" },
    });
    component.render();
    component.commit();
    assert.equal(storage.get("persona-draft"), originalDraft + "\nMore detail");
    component.dispose();
    component = mountUI({ storage });
    component.render();
    component.commit();
    component.replayMount();
    component.render();
    component.commit();
    assert.equal(
      component.textarea()?.props.value,
      originalDraft + "\nMore detail",
    );
    assert.ok(!component.writes.includes(""));
  } finally {
    component.dispose();
  }
});
