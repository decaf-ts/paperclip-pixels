/**
 * Behavior signal rendering tests (spec PAPERCLIP_PIXELS-1, §9.3,
 * §11.11–11.12, FR-15). Proxies render value + confidence + basis as an
 * operational estimate — never as factual emotion.
 *
 * The environment's pinned react commits asynchronously, so every render is
 * followed by `await waitFor(...)` before asserting.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { BehaviorSignal } from "./behavior-signal";
import {
  ENGAGEMENT_PROXY_NOTE,
  STRESS_PROXY_NOTE,
} from "../format";

const signalReady = async () => {
  await waitFor(() =>
    expect(screen.getByTestId("behavior-signal")).toBeInTheDocument(),
  );
  return screen.getByTestId("behavior-signal");
};

describe("BehaviorSignal — operational rendering", () => {
  it("renders label, banded value as a percentage, confidence, and basis", async () => {
    render(
      <BehaviorSignal
        label="friction"
        signal={{
          value: 0.85,
          confidence: 0.9,
          basis: ["run-workspan", "retry-count"],
        }}
      />,
    );
    const item = await signalReady();
    expect(item).toHaveTextContent("friction");
    expect(item).toHaveTextContent("high · 85%");
    expect(item).toHaveTextContent("confidence 90%");
    expect(item).toHaveTextContent("basis: run-workspan, retry-count");
  });

  it("falls back to 'no recorded basis' when the basis is empty", async () => {
    render(
      <BehaviorSignal
        label="load"
        signal={{ value: 0.3, confidence: 0.6, basis: [] }}
      />,
    );
    expect(await signalReady()).toHaveTextContent("basis: no recorded basis");
  });

  it("clamps out-of-range values to 0–100%", async () => {
    render(
      <BehaviorSignal
        label="load"
        signal={{ value: 1.5, confidence: 0.8, basis: [] }}
      />,
    );
    expect(await signalReady()).toHaveTextContent("high · 100%");
  });

  it("renders the operational-proxy disclaimer note when provided", async () => {
    render(
      <BehaviorSignal
        label="stress proxy (operational estimate)"
        note={STRESS_PROXY_NOTE}
        signal={{ value: 0.5, confidence: 0.7, basis: [] }}
      />,
    );
    const item = await signalReady();
    expect(item).toHaveTextContent(STRESS_PROXY_NOTE);
    expect(item).toHaveTextContent("Not a claim about subjective emotion.");
  });

  it("never renders emotion labels for stress/engagement proxies", async () => {
    render(
      <>
        <BehaviorSignal
          label="stress proxy (operational estimate)"
          note={STRESS_PROXY_NOTE}
          signal={{ value: 0.7, confidence: 0.6, basis: [] }}
        />
        <BehaviorSignal
          label="engagement proxy (operational estimate)"
          note={ENGAGEMENT_PROXY_NOTE}
          signal={{ value: 0.4, confidence: 0.6, basis: [] }}
        />
      </>,
    );
    const items = await waitFor(() => screen.getAllByTestId("behavior-signal"));
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toHaveTextContent("operational estimate");
      const text = item.textContent ?? "";
      for (const emotion of ["unhappy", "stressed", "satisfied", "not satisfied"]) {
        expect(text).not.toMatch(emotion);
      }
    }
    const text = items.map((i) => i.textContent ?? "").join(" ");
    expect(text).toContain(STRESS_PROXY_NOTE);
    expect(text).toContain(ENGAGEMENT_PROXY_NOTE);
  });
});
