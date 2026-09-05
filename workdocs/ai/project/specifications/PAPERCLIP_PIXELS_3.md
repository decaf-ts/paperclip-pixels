# PAPERCLIP_PIXELS-3

Compatibility-Preserved Plugin Layer for Pixel Agents

Date: 2026-09-05

## 1. Objective

Refactor Pixel Agents into a plugin-oriented architecture while preserving the original runtime behavior as the default implementation.

The original Claude/hook-based behavior must remain the baseline runtime, expressed as a first-class default plugin. Paperclip-specific behavior must be implemented as an additional plugin layer that overrides selected capabilities without breaking the baseline.

This specification defines:
- the target architecture
- the compatibility and override contracts
- the migration path
- the acceptance criteria required for delivery

## 2. Desired End State

The system must satisfy all of the following:

- The original Pixel Agents behavior remains the default.
- The original behavior is modeled as a plugin.
- Paperclip-specific behavior is implemented as a separate plugin.
- The Paperclip plugin can override selected capabilities.
- Any capability not overridden falls back to the base/default plugin.
- If only the base plugin is loaded, the system behaves like the pre-refactor Pixel Agents runtime.
- Existing Claude-hook installation and communication behavior remains the default unless explicitly overridden.

## 3. Non-Goals

This effort does not aim to:

- replace the default runtime behavior with Paperclip-specific behavior
- remove Claude-hook support from the baseline path
- make plugin behavior implicitly authoritative over default behavior
- change installation or communication defaults without explicit configuration
- allow Paperclip-specific logic to leak into unrelated baseline paths
- introduce ambiguous override behavior

## 4. Architecture Summary

The architecture has three layers:

1. Base/default plugin
2. Plugin host arbitration layer
3. Paperclip override plugin

### 4.1 Base/Default Plugin

The base plugin represents the original Pixel Agents behavior. It must implement the legacy Claude/hook runtime semantics and serve as the fallback for all capabilities not overridden by downstream plugins.

### 4.2 Plugin Host

The host is not the business logic. It is the capability resolution layer. It must:

- register plugins in deterministic order
- resolve capabilities using explicit priority
- fall back to the base plugin when no override exists
- fail closed when no implementation exists
- prevent implicit cross-plugin coupling

### 4.3 Paperclip Override Plugin

The Paperclip plugin is a specialization layer. It may override only declared capabilities and must delegate everything else back to the base plugin.

It may provide:

- bridge mapping
- Paperclip-specific UI surfaces
- appearance and labeling overrides
- Paperclip-specific policy behavior
- any compatibility shims needed to adapt Paperclip state to the default runtime

## 5. Core Contracts

## 5.1 Default Compatibility Contract

When the Paperclip plugin is not loaded, the runtime must behave identically to the legacy Pixel Agents experience.

This includes:

- hook installation and removal
- consent flows
- provider selection
- session lifecycle
- tool-activity derivation
- transcript parsing
- existing UI behavior
- persistence behavior

## 5.2 Override Contract

When the Paperclip plugin is loaded, it may override only explicitly declared capabilities.

The override contract must guarantee:

- deterministic precedence
- explicit fallback to the base plugin
- no mutation of undeclared capabilities
- no silent replacement of unrelated behavior

## 5.3 Capability Resolution Contract

Each capability must resolve in the following order:

1. Highest-priority explicit override
2. Base/default implementation
3. Fail closed if no implementation exists

The host must not guess, synthesize, or implicitly redirect behavior.

## 5.4 Transport Contract

The default transport must remain the original Claude/hook-based path.

Any alternate transport introduced for Paperclip must be:

- explicitly enabled
- configuration-driven
- isolated from the default path
- documented as an override, not a replacement

## 5.5 UI Contract

The default UI must remain equivalent to the pre-refactor behavior.

Plugin UI additions must be:

- additive
- explicitly declared
- isolated from baseline surfaces
- unable to suppress default views unless explicitly configured to do so

## 5.6 Data Contract

Persistent state must distinguish:

- base/default plugin state
- override/plugin-specific state
- shared runtime state

Plugin-specific state must not overwrite baseline state unless the capability contract explicitly allows it.

## 5.7 Security Contract

All plugin behavior must fail closed.

The system must prevent:

- implicit privilege escalation through plugin loading
- hidden transport changes
- unauthorized work creation paths
- direct mutation outside declared interfaces
- cross-plugin state corruption

## 6. Implementation Strategy

The work should proceed in five phases.

### Phase 1: Extract the Base Plugin

Move the original behavior into a base plugin without changing runtime output.

Deliverables:

- a base/default plugin
- baseline behavior matching the pre-refactor runtime
- compatibility tests proving equivalence

### Phase 2: Add Host-Level Arbitration

Introduce a plugin host that resolves capabilities by priority and fallback.

Deliverables:

- plugin registration
- capability lookup
- deterministic override order
- fail-closed behavior

### Phase 3: Implement the Paperclip Plugin

Create the Paperclip-specific plugin on top of the default plugin.

Deliverables:

- bridge-specific overrides
- Paperclip UI integrations
- policy and appearance specializations
- explicit fallback to baseline behavior

### Phase 4: Add Compatibility Guards

Lock the baseline behavior through tests.

Deliverables:

- default-behavior equivalence tests
- override-isolation tests
- fallback tests
- transport compatibility tests
- security tests

### Phase 5: Stabilize and Document

Document the runtime contract and the operational model.

Deliverables:

- capability matrix
- override rules
- operator configuration guidance
- migration notes

## 7. Functional Requirements

### 7.1 Plugin Registration

Plugins must declare:

- identity
- version
- capabilities
- override scope
- fallback behavior

Registration must fail closed when:

- required metadata is missing
- capability declarations conflict
- overrides are ambiguous
- the plugin is malformed

### 7.2 Capability Dispatch

The host must dispatch each capability independently.

It must support:

- direct implementation
- override
- wrap-and-delegate
- fallback to base implementation

### 7.3 Base Runtime Preservation

The base/default plugin must implement the legacy runtime behavior as-is.

It must preserve:

- default hook install behavior
- default provider behavior
- default communication behavior
- default UI defaults
- default parsing and lifecycle behavior

### 7.4 Paperclip Specialization

The Paperclip plugin may specialize the runtime for Paperclip needs.

It may override:

- bridge translation
- UI contribution points
- appearance and policy handling
- Paperclip-specific action routing

It may not:

- silently alter baseline behaviors outside its scope
- replace the baseline runtime without explicit configuration

## 8. Acceptance Criteria

The implementation is complete only when all of the following are true:

- The legacy Pixel Agents behavior is available as the default plugin.
- The default plugin reproduces the pre-refactor behavior.
- The Paperclip plugin layers on top of the default plugin.
- Unoverridden behavior falls back to the base plugin.
- Default installation and communication behavior remain unchanged unless explicitly overridden.
- The system passes compatibility, regression, and security tests.
- Operators can reason about runtime behavior from configuration alone.

## 9. Risks

### 9.1 Behavioral Drift

The extracted base plugin may diverge from the legacy runtime.

Mitigation:

- snapshot tests
- equivalence tests
- side-by-side verification

### 9.2 Override Leakage

Paperclip-specific behavior may spill into the baseline path.

Mitigation:

- strict capability scoping
- explicit host arbitration
- tests for non-overridden behavior

### 9.3 Configuration Ambiguity

Multiple modes may be enabled without clear precedence.

Mitigation:

- deterministic priority rules
- single source of truth for mode selection
- fail-closed validation

### 9.4 Hidden Coupling

The base plugin may begin depending on Paperclip-specific assumptions.

Mitigation:

- hard separation between base and specialization layers
- dependency rules enforced in review and tests

## 10. Delivery Notes

The correct implementation sequence is:

1. extract the original runtime into a base plugin
2. introduce the host arbitration layer
3. implement the Paperclip override plugin
4. prove baseline equivalence with tests
5. enable Paperclip-specific behavior only through explicit configuration

This is a compatibility-preserving migration, not a wholesale replacement.

