/**
 * Company intake tests (spec PAPERCLIP_PIXELS-1, §17, §26.1, FR-6, §30.1).
 *
 * The intake surface is the ONLY UI path that may originate new-work intent.
 * It must submit through the worker's `company.send-message` action, validate
 * locally before sending, and block sending while the bridge is stale.
 *
 * NOTE: the pinned react commits asynchronously; render/event effects are
 * awaited with `waitFor` before assertions.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CompanyIntake } from "./company-intake";
import { usePluginActionImpl } from "../test-utils/sdk-ui";
import { BRIDGE_MESSAGE_MAX_LENGTH } from "../new-work-gate";

function renderIntake(overrides: Partial<React.ComponentProps<typeof CompanyIntake>> = {}) {
  const props: React.ComponentProps<typeof CompanyIntake> = {
    companyId: "co",
    disabled: false,
    prefill: null,
    onPrefillConsumed: jest.fn(),
    ...overrides,
  };
  render(<CompanyIntake {...props} />);
  return props;
}

const inputReady = () =>
  waitFor(() =>
    expect(screen.getByTestId("company-intake-input")).toBeInTheDocument(),
  );

const submit = async (text: string) => {
  fireEvent.change(screen.getByTestId("company-intake-input"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByTestId("company-intake-send"));
};

describe("CompanyIntake — submission", () => {
  it("sends company.send-message with trimmed { companyId, text }", async () => {
    const action = jest.fn().mockResolvedValue({ kind: "accepted" });
    usePluginActionImpl.mockReturnValue(action);
    renderIntake();
    await inputReady();

    await submit("  Build a new billing page.  ");
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith({
        companyId: "co",
        text: "Build a new billing page.",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("company-intake-input")).toHaveValue(""),
    );
  });

  it("shows a sent count after a successful send", async () => {
    usePluginActionImpl.mockReturnValue(jest.fn().mockResolvedValue(undefined));
    renderIntake();
    await inputReady();

    await submit("Ship the API");
    await waitFor(() =>
      expect(screen.getByText(/1 message sent/)).toBeInTheDocument(),
    );
  });

  it("does not submit empty text and shows a local validation error", async () => {
    const action = jest.fn();
    usePluginActionImpl.mockReturnValue(action);
    renderIntake();
    await inputReady();

    fireEvent.click(screen.getByTestId("company-intake-send"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enter a message for the company.",
      ),
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("does not submit overlong text", async () => {
    const action = jest.fn();
    usePluginActionImpl.mockReturnValue(action);
    renderIntake();
    await inputReady();

    await submit("x".repeat(BRIDGE_MESSAGE_MAX_LENGTH + 1));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        `Message must be ${BRIDGE_MESSAGE_MAX_LENGTH} characters or fewer.`,
      ),
    );
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByTestId("company-intake-input")).toHaveValue(
      "x".repeat(BRIDGE_MESSAGE_MAX_LENGTH + 1),
    );
  });
});

describe("CompanyIntake — stale blocking (§30.1)", () => {
  it("disables the textarea and send button while stale and never calls the action", async () => {
    const action = jest.fn();
    usePluginActionImpl.mockReturnValue(action);
    renderIntake({ disabled: true });
    await inputReady();

    await waitFor(() =>
      expect(screen.getByTestId("company-intake-send")).toBeDisabled(),
    );
    expect(screen.getByTestId("company-intake-input")).toBeDisabled();

    fireEvent.click(screen.getByTestId("company-intake-send"));
    await waitFor(() => expect(action).not.toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByText(
          /Disconnected — sending is paused until the bridge reconnects/,
        ),
      ).toBeInTheDocument(),
    );
  });
});

describe("CompanyIntake — worker errors", () => {
  it("surfaces the error and retains the draft text", async () => {
    const action = jest
      .fn()
      .mockRejectedValue(new Error("worker refused the action"));
    usePluginActionImpl.mockReturnValue(action);
    renderIntake();
    await inputReady();

    await submit("Keep this draft");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "worker refused the action",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("company-intake-input")).toHaveValue(
        "Keep this draft",
      ),
    );
  });
});

describe("CompanyIntake — fail-closed reroute prefill", () => {
  it("prefills the textarea and consumes the prefill", async () => {
    const onPrefillConsumed = jest.fn();
    renderIntake({
      prefill: "Routed from agent reply.",
      onPrefillConsumed,
    });
    await waitFor(() =>
      expect(screen.getByTestId("company-intake-input")).toHaveValue(
        "Routed from agent reply.",
      ),
    );
    await waitFor(() => expect(onPrefillConsumed).toHaveBeenCalledTimes(1));
  });

  it("does not consume an empty prefill on first render", async () => {
    const onPrefillConsumed = jest.fn();
    renderIntake({ onPrefillConsumed });
    await inputReady();
    expect(onPrefillConsumed).not.toHaveBeenCalled();
  });
});
