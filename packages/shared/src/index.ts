export type TestRunStatus = "queued" | "running" | "success" | "failed" | "error" | "unknown";

export interface LiferayVersionOption {
  key: string;
  label: string;
  dockerTag: string;
  track: "quarterly" | "ga";
}
