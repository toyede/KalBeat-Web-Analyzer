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
    description: "마디 첫 박을 포함한 모든 정박입니다. 기본 박 유지와 메인 이벤트 확인에 가장 직접적인 기준입니다.",
  },
  offbeat: {
    label: "8분 오프비트",
    shortLabel: "8분",
    description: "정박과 정박 사이의 반박입니다. 보조 타격이나 엇박감을 만들기 좋은 위치입니다.",
  },
  subdivision: {
    label: "16분 세분",
    shortLabel: "16분",
    description: "정박과 오프비트 사이를 한 번 더 쪼갠 16분 위치입니다. 빠른 리듬의 기본 후보로 쓰기 좋습니다.",
  },
  thirtySecond: {
    label: "32분 세분",
    shortLabel: "32분",
    description: "16분 사이를 한 번 더 쪼갠 촘촘한 후보입니다. 빠른 장식음이나 세밀한 클릭 후보를 더 많이 보여줍니다.",
  },
  triplet: {
    label: "3연음 / 셔플",
    shortLabel: "3연",
    description: "한 박을 3등분한 후보입니다. 셔플 느낌, 스윙, 보컬 프레이즈의 3연 패턴을 잡을 때 유용합니다.",
  },
  freeAccent: {
    label: "자유 악센트",
    shortLabel: "자유",
    description: "현재 박자 그리드 밖에서 강하게 검출된 onset입니다. 그리드로 설명되지 않는 액센트를 따로 확인할 수 있습니다.",
  },
};
