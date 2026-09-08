/**
 * Individual-agent feedback popup tests (spec PAPERCLIP_PIXELS-1, §5.2,
 * §18, §26.3, FR-7, FR-8).
 *
 * The reply surface is fail-closed: no reply affordance without an existing
 * work context, no submission of new-work-looking text, and the worker's
 * route-to-company outcome is honored (defense in depth).
 *
 * NOTE: the pinned react commits asynchronously; render/event effects are
 * awaited with `waitFor` before assertions.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeedbackPopup } from "./feedback-popup";
import { makeFeedback } from "../test-utils/fixtures";
import { makeNavigation, usePluginActionImpl } from "../test-utils/sdk-ui";

function renderPopup(
  props: Partial<React.ComponentProps<typeof FeedbackPopup>> = {},
) {
  const onSendToCompany = jest.fn();
  const onDismiss = jest.fn();
  const navigation = makeNavigation();
  const propsToRender: React.ComponentProps<typeof FeedbackPopup> = {
    feedback: makeFeedback(),
    companyId: "co",
    disabled: false,
    navigation,
    onSendToCompany,
    onDismiss,
    ...props,
  };
  render(<FeedbackPopup {...propsToRender} />);
  return { onSendToCompany, onDismiss, navigation };
}

const ready = () =>
  waitFor(() =>
    expect(screen.getByTestId("feedback-popup")).toBeInTheDocument(),
  );

describe("FeedbackPopup — no existing work context (fail closed)", () => {
  it("offers Send to company, never a Reply affordance, and performs no mutation", async () => {
    const replyAction = jest.fn();
    usePluginActionImpl.mockReturnValue(replyAction);
    const { onSendToCompany } = renderPopup({
      feedback: makeFeedback({ existingWorkContext: false, issueId: "iss-1" }),
    });
    await ready();

    expect(screen.queryByTestId("feedback-reply")).not.toBeInTheDocument();
    expect(
      screen.getByText(/This feedback is not bound to existing work/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("feedback-send-to-company"));
    await waitFor(() => expect(onSendToCompany).toHaveBeenCalled());
    expect(replyAction).not.toHaveBeenCalled();
  });
});

describe("FeedbackPopup — new-work-looking reply text (§18.3)", () => {
  it("disables Reply, shows the reroute notice, and never submits", async () => {
    const replyAction = jest.fn();
    usePluginActionImpl.mockReturnValue(replyAction);
    renderPopup();
    await ready();

    const input = screen.getByTestId("feedback-reply-input");
    fireEvent.change(input, {
      target: { value: "Also build a brand new CRM" },
    });

    await waitFor(() => expect(screen.getByTestId("feedback-reply")).toBeDisabled());
    expect(screen.getByTestId("feedback-reroute-notice")).toHaveTextContent(
      /looks like new work/,
    );

    fireEvent.click(screen.getByTestId("feedback-reply"));
    await waitFor(() => expect(replyAction).not.toHaveBeenCalled());
  });
});

describe("FeedbackPopup — valid bound reply", () => {
  it("sends agent.reply-to-feedback with { companyId, feedbackId, text }", async () => {
    const replyAction = jest.fn().mockResolvedValue({ kind: "sent" });
    usePluginActionImpl.mockReturnValue(replyAction);
    renderPopup({
      feedback: makeFeedback({
        id: "fb-9",
        issueId: "iss-9",
        runId: "run-9",
      }),
    });
    await ready();

    fireEvent.change(screen.getByTestId("feedback-reply-input"), {
      target: { value: "  Continuing work on this issue.  " },
    });
    fireEvent.click(screen.getByTestId("feedback-reply"));

    await waitFor(() =>
      expect(replyAction).toHaveBeenCalledWith({
        companyId: "co",
        feedbackId: "fb-9",
        text: "Continuing work on this issue.",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("feedback-sent")).toBeInTheDocument(),
    );
  });

  it("does not submit empty text", async () => {
    const replyAction = jest.fn();
    usePluginActionImpl.mockReturnValue(replyAction);
    renderPopup();
    await ready();

    fireEvent.click(screen.getByTestId("feedback-reply"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enter a reply for the agent.",
      ),
    );
    expect(replyAction).not.toHaveBeenCalled();
  });
});

describe("FeedbackPopup — worker route-to-company outcome (defense in depth)", () => {
  it("does not mark sent, shows the reason, and routes suggested text to intake", async () => {
    const replyAction = jest.fn().mockResolvedValue({
      kind: "route-to-company",
      reason: "new-work",
      suggestedText: "Build the CRM through intake",
    });
    usePluginActionImpl.mockReturnValue(replyAction);
    const { onSendToCompany } = renderPopup();
    await ready();

    // Ordinary (non-new-work) text so the client gate passes; the WORKER is
    // what independently decides to route to company.
    fireEvent.change(screen.getByTestId("feedback-reply-input"), {
      target: { value: "The numbers look right, continuing in this issue." },
    });
    fireEvent.click(screen.getByTestId("feedback-reply"));

    await waitFor(() =>
      expect(replyAction).toHaveBeenCalledWith({
        companyId: "co",
        feedbackId: "fb-1",
        text: "The numbers look right, continuing in this issue.",
      }),
    );
    expect(screen.queryByTestId("feedback-sent")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("feedback-error")).toHaveTextContent(
        /was not sent to the agent/,
      ),
    );
    expect(onSendToCompany).toHaveBeenCalledWith("Build the CRM through intake");
  });

  it("did not mutate when the worker decides the reply is new work", async () => {
    const replyAction = jest.fn().mockResolvedValue({
      kind: "route-to-company",
      reason: "new-work",
      suggestedText: "Build the CRM through intake",
    });
    usePluginActionImpl.mockReturnValue(replyAction);
    const { onSendToCompany } = renderPopup();
    await ready();

    fireEvent.change(screen.getByTestId("feedback-reply-input"), {
      target: { value: "The numbers look right, continuing in this issue." },
    });
    fireEvent.click(screen.getByTestId("feedback-reply"));

    await waitFor(() =>
      expect(onSendToCompany).toHaveBeenCalledWith("Build the CRM through intake"),
    );
    expect(replyAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("feedback-sent")).not.toBeInTheDocument();
  });

  it("surfaces a missing-context worker outcome without routing stale text", async () => {
    const replyAction = jest.fn().mockResolvedValue({
      kind: "route-to-company",
      reason: "missing-context",
    });
    usePluginActionImpl.mockReturnValue(replyAction);
    const { onSendToCompany } = renderPopup({
      feedback: makeFeedback({ issueId: "iss-9" }),
    });
    await ready();

    fireEvent.change(screen.getByTestId("feedback-reply-input"), {
      target: { value: "thanks" },
    });
    fireEvent.click(screen.getByTestId("feedback-reply"));

    await waitFor(() =>
      expect(screen.getByTestId("feedback-error")).toHaveTextContent(
        /has no existing work context/,
      ),
    );
    expect(onSendToCompany).not.toHaveBeenCalled();
    expect(screen.queryByTestId("feedback-sent")).not.toBeInTheDocument();
  });
});

describe("FeedbackPopup — context link and dismiss", () => {
  it("renders Open work context when an issueId is present", async () => {
    const { navigation } = renderPopup({
      feedback: makeFeedback({ issueId: "iss-42" }),
    });
    const link = await waitFor(() => screen.getByTestId("feedback-open-context"));
    expect(link).toHaveTextContent("Open work context");
    expect(link).toHaveAttribute(
      "href",
      navigation.resolveHref("/issues/iss-42"),
    );
  });

  it("omits Open work context when no issueId is present", async () => {
    renderPopup({
      feedback: makeFeedback({ issueId: undefined, runId: "run-1" }),
    });
    await ready();
    expect(screen.queryByTestId("feedback-open-context")).not.toBeInTheDocument();
  });

  it("dismisses by calling onDismiss with the feedback id", async () => {
    const { onDismiss } = renderPopup({
      feedback: makeFeedback({ id: "fb-x" }),
    });
    await ready();
    fireEvent.click(screen.getByTestId("feedback-dismiss"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith("fb-x"));
  });
});
