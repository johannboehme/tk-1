/**
 * BPM domain value shared by the editor readout, triage detection and
 * the triage store. Lives in core/ so pipeline code never has to
 * import a React component file to get the type.
 */
export interface BpmValue {
  value: number;
  manualOverride: boolean;
  confidence?: number;
}
