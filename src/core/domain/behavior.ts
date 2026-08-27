/**
 * Behavioral proxy contract (spec §9.3).
 *
 * Every proxy is an OPERATIONAL estimate derived from observed evidence, never
 * a claim about subjective emotion (FR-15, §11.11–11.12). Each signal carries
 * a normalized value, a confidence score, and machine-readable provenance keys.
 */

export interface BehavioralSignal {
  value: number; // normalized [0, 1]
  confidence: number; // normalized [0, 1]
  basis: string[]; // machine-readable provenance keys
}

export interface AgentBehaviorVector {
  agentId: string;
  companyId: string;
  calculatedAt: string;

  load: BehavioralSignal;
  sustainedLoad: BehavioralSignal;
  burstiness: BehavioralSignal;

  friction: BehavioralSignal;
  failurePressure: BehavioralSignal;
  interruptionPressure: BehavioralSignal;

  collaboration: BehavioralSignal;
  waiting: BehavioralSignal;
  idleAvailability: BehavioralSignal;

  contextSwitching: BehavioralSignal;
  projectSpread: BehavioralSignal;

  momentum: BehavioralSignal;

  /**
   * Optional higher-level proxies.
   * Never expose these as factual emotion.
   */
  stressProxy?: BehavioralSignal;
  engagementProxy?: BehavioralSignal;
}

/**
 * A behavior vector together with its schema version, for serialized payloads.
 * Every serialized bridge payload carries `schemaVersion: 1` (§33.1, NFR-6).
 */
export interface VersionedAgentBehaviorVector extends AgentBehaviorVector {
  schemaVersion: 1;
}

/** Hysteresis band (spec §24): enter/exit thresholds prevent animation thrash. */
export interface Hysteresis {
  enter: number;
  exit: number;
}
