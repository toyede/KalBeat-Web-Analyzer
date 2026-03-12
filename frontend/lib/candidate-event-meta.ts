import type { CandidateTimingRole } from "@/lib/types";

export const timingRoleOrder: CandidateTimingRole[] = ["downbeat", "beat", "offbeat", "subdivision"];

export const timingRoleMeta: Record<
  CandidateTimingRole,
  { label: string; description: string; shortLabel: string }
> = {
  downbeat: {
    label: "마디 시작 정박",
    shortLabel: "마디 시작",
    description: "4/4 기준 각 마디의 첫 박입니다. 큰 전환점이나 강한 이벤트를 두기 좋습니다.",
  },
  beat: {
    label: "정박",
    shortLabel: "정박",
    description: "마디 안의 기본 박입니다. 안정적인 메인 이벤트를 두기 좋은 위치입니다.",
  },
  offbeat: {
    label: "8분 오프비트",
    shortLabel: "8분",
    description: "정박 사이의 반 박 위치입니다. 보조 타격이나 엇박 느낌을 만들기 좋습니다.",
  },
  subdivision: {
    label: "16분 세분",
    shortLabel: "16분",
    description: "정박과 오프비트 사이를 다시 쪼갠 위치입니다. 촘촘한 장식 이벤트에 적합합니다.",
  },
};
