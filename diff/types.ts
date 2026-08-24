export interface DiffSnapshot {
  encoding: "gzip+base64";
  original: string;
  modified: string;
}

export interface TurnFileChange {
  path: string;
  snapshot: DiffSnapshot;
}

export interface TurnChanges {
  assistantEntryId: string;
  changes: TurnFileChange[];
}
