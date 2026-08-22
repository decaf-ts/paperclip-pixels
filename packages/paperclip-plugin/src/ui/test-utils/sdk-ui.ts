/**
 * Controllable mock for `@paperclipai/plugin-sdk/ui` (spec PAPERCLIP_PIXELS-1,
 * FR-9/§28.2).
 *
 * The real SDK reads from the host runtime registry (`getSdkUiRuntimeValue`)
 * which is unavailable outside a running host. Tests import this module
 * directly (module-name-mapped in jest) so per-test state is fully
 * controlled. Components keep importing `@paperclipai/plugin-sdk/ui`; the
 * jest `moduleNameMapper` redirects that specifier here at runtime.
 */

import { jest } from "@jest/globals";

export interface MockPluginDataResult<T = unknown> {
  data: T | null;
  loading: boolean;
  error: { message: string; code?: string } | null;
  refresh: ReturnType<typeof jest.fn>;
}

export interface MockPluginStreamResult<T = unknown> {
  events: T[];
  lastEvent: T | null;
  connecting: boolean;
  connected: boolean;
  error: Error | null;
  close: ReturnType<typeof jest.fn>;
}

/** Shape of the async function returned by `usePluginAction`. */
export type MockActionFn = ReturnType<typeof jest.fn>;

export interface HostNavigationLinkProps {
  href: string;
  target?: string;
  rel?: string;
  onClick: (...args: unknown[]) => void;
}

export interface HostNavigation {
  resolveHref(to: string): string;
  navigate(to: string, options?: Record<string, unknown>): void;
  linkProps(to: string, options?: Record<string, unknown>): HostNavigationLinkProps;
}

export interface PluginHostContext {
  companyId: string | null;
  companyPrefix?: string | null;
  projectId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  userId?: string | null;
  [key: string]: unknown;
}

export interface PluginPageProps {
  context: PluginHostContext;
}

export interface PluginSidebarProps {
  context: PluginHostContext;
}

export interface MockStreamOptions {
  companyId?: string;
}

// Backing jest mocks. Tests control these directly.
export const usePluginDataImpl = jest.fn();
export const usePluginStreamImpl = jest.fn();
export const usePluginActionImpl = jest.fn();
export const useHostContextImpl = jest.fn();
export const useHostNavigationImpl = jest.fn();
export const usePluginToastImpl = jest.fn();

/** Factory for a `usePluginData` result. Tests override `refresh` to assert on it. */
export function makeDataResult<T = unknown>(
  overrides?: Partial<MockPluginDataResult<T>> | null,
): MockPluginDataResult<T> {
  return {
    data: null,
    loading: false,
    error: null,
    refresh: jest.fn(),
    ...overrides,
  };
}

/** Factory for a `usePluginStream` result. */
export function makeStreamResult<T = unknown>(
  overrides?: Partial<MockPluginStreamResult<T>>,
): MockPluginStreamResult<T> {
  return {
    events: [] as T[],
    lastEvent: null,
    connecting: false,
    connected: false,
    error: null,
    close: jest.fn(),
    ...overrides,
  };
}

/** Factory for a `useHostNavigation` result. */
export function makeNavigation(
  overrides?: Partial<HostNavigation>,
): HostNavigation {
  const resolveHref = jest.fn((to: string) => to);
  const navigate = jest.fn();
  const linkProps = jest.fn((to: string) => ({
    href: resolveHref(to),
    onClick: jest.fn(),
  }));
  return { resolveHref, navigate, linkProps, ...overrides };
}

/**
 * Restore all SDK mocks to sane defaults. Called in `jest-setup.ts` before
 * every test so state never leaks between tests.
 */
export function resetSdkUiMocks(): void {
  usePluginDataImpl.mockReset();
  usePluginDataImpl.mockReturnValue(makeDataResult(null));
  usePluginStreamImpl.mockReset();
  usePluginStreamImpl.mockReturnValue(makeStreamResult());
  usePluginActionImpl.mockReset();
  usePluginActionImpl.mockReturnValue(
    jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  );
  useHostContextImpl.mockReset();
  useHostContextImpl.mockReturnValue({ companyId: null });
  useHostNavigationImpl.mockReset();
  useHostNavigationImpl.mockReturnValue(makeNavigation());
  usePluginToastImpl.mockReset();
  usePluginToastImpl.mockReturnValue(jest.fn());
}

// The hooks the components import. Each delegates to the backing jest mock,
// so resetting/mocking `*Impl` controls behavior from tests.
export function usePluginData<T = unknown>(
  key: string,
  params?: Record<string, unknown>,
): MockPluginDataResult<T> {
  return usePluginDataImpl(key, params) as MockPluginDataResult<T>;
}

export function usePluginStream<T = unknown>(
  channel: string,
  options?: MockStreamOptions,
): MockPluginStreamResult<T> {
  return usePluginStreamImpl(channel, options) as MockPluginStreamResult<T>;
}

export function usePluginAction(key: string): MockActionFn {
  return usePluginActionImpl(key) as MockActionFn;
}

export function useHostContext(): PluginHostContext {
  return useHostContextImpl() as PluginHostContext;
}

export function useHostNavigation(): HostNavigation {
  return useHostNavigationImpl() as HostNavigation;
}

export function usePluginToast(): MockActionFn {
  return usePluginToastImpl() as MockActionFn;
}
