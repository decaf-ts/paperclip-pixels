/**
 * Jest setup for the Paperclip plugin UI tests.
 *
 * - Registers `@testing-library/jest-dom` matchers.
 * - Opts into React's `act()` environment (required by React 19).
 * - Installs a minimal `React.act` shim: the workspace's pinned `react@19.2.8`
 *   build ships without the `act` export that `@testing-library/react` 16 and
 *   `react-dom/test-utils` delegate to. This shim is installed here (a
 *   `setupFilesAfterEnv` file, which jest evaluates before any test module) so
 *   that `@testing-library/react`'s act-compat picks it up at module load. The
 *   harness React is concurrent-less, so render/commit/effects complete
 *   synchronously and a passthrough satisfying the act contract is correct.
 * - Resets the SDK hook mocks before every test so no state leaks.
 */

import React from "react";
import { flushSync } from "react-dom";
import "@testing-library/jest-dom";
import { resetSdkUiMocks } from "./sdk-ui";

type ActShim = (callback: () => void | Promise<unknown>) => unknown;

const ReactAny = React as unknown as { act?: ActShim };
if (typeof ReactAny.act !== "function") {
  ReactAny.act = (callback: () => void | Promise<unknown>) => {
    const flush = () => {
      try {
        flushSync(() => {});
      } catch {
        // flushSync throws when there is no queued work to flush.
      }
    };
    const result = callback();
    flush();
    // The pinned react build schedules concurrent work that only commits when
    // flushed. A deferred flush lets async continuations (e.g. awaited worker
    // actions that then setState) commit before the next waitFor()/timer tick.
    setTimeout(flush, 0);
    if (result && typeof result.then === "function") {
      return (result as Promise<unknown>).then(() => {
        flush();
        return undefined;
      });
    }
    return undefined;
  };
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  resetSdkUiMocks();
});
