export interface CaseCheckpointChannel {
  readonly directory: string;
  close(): Promise<void>;
}

export function createCaseCheckpointChannel(options: {
  nonce: string;
  file: string;
  onMarker?: (marker: string) => void;
}): Promise<CaseCheckpointChannel>;
