import type { CandidateTimingRole } from "@/lib/types";

export const timingRoleOrder: CandidateTimingRole[] = [
  "pulse",
  "offbeat",
  "subdivision",
  "thirtySecond",
  "triplet",
  "freeAccent",
];

export const timingRoleMeta: Record<
  CandidateTimingRole,
  { label: string; description: string; shortLabel: string }
> = {
  pulse: {
    label: "정박",
    shortLabel: "정박",
    description: "마디의 기본 박자선에 걸린 후보입니다.",
  },
  offbeat: {
    label: "8분 오프비트",
    shortLabel: "8분",
    description: "정박 사이의 반박 위치에 걸린 후보입니다.",
  },
  subdivision: {
    label: "16분 분할",
    shortLabel: "16분",
    description: "더 잘게 쪼개진 16분 기준 후보입니다.",
  },
  thirtySecond: {
    label: "32분 분할",
    shortLabel: "32분",
    description: "매우 촘촘한 32분 기준 후보입니다.",
  },
  triplet: {
    label: "셋잇단 / 셔플",
    shortLabel: "셋잇단",
    description: "셋잇단이나 셔플 성향의 후보입니다.",
  },
  freeAccent: {
    label: "자유 악센트",
    shortLabel: "자유",
    description: "격자 바깥에서 강하게 튀는 onset 후보입니다.",
  },
};
