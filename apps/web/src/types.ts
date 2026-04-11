export interface LiferayVersionOption {
  key: string;
  label: string;
  dockerTag: string;
  track: "quarterly" | "ga";
}

export interface VersionsResponse {
  versions: LiferayVersionOption[];
}
