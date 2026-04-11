import type { LiferayVersionOption } from "@lma/shared";

export const LIFERAY_VERSION_OPTIONS: LiferayVersionOption[] = [
  {
    key: "dxp-2026-q1",
    label: "DXP 2026 Q1",
    dockerTag: "2026.q1.3-lts",
    track: "quarterly",
  },
  {
    key: "dxp-2025-q4",
    label: "DXP 2025 Q4",
    dockerTag: "2025.q4",
    track: "quarterly",
  },
  {
    key: "dxp-2025-q3",
    label: "DXP 2025 Q3",
    dockerTag: "2025.q3",
    track: "quarterly",
  },
  {
    key: "dxp-2025-q2",
    label: "DXP 2025 Q2",
    dockerTag: "2025.q2",
    track: "quarterly",
  },
  {
    key: "dxp-2025-q1",
    label: "DXP 2025 Q1",
    dockerTag: "2025.q1",
    track: "quarterly",
  },
  {
    key: "dxp-7-4",
    label: "DXP 7.4",
    dockerTag: "7.4.13.nightly",
    track: "ga",
  },
];

export function getLiferayVersionByKey(key: string) {
  return LIFERAY_VERSION_OPTIONS.find((option) => option.key === key);
}
