export type TestProgressEvent =
  | { type: "status"; status: string }
  | { type: "log"; line: string }
  | { type: "result"; status: "success" | "failed" | "error"; summary: string };

export function serializeTestProgressEvent(event: TestProgressEvent) {
  return JSON.stringify(event);
}
