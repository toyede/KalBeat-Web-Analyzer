import type { CandidateSceneFamily, CandidateSceneType } from "@/lib/types";

export const candidateSceneFamilyOrder: CandidateSceneFamily[] = ["reactive", "pattern"];

export const candidateSceneTypeOrder: CandidateSceneType[] = [
  "prep_1_attack",
  "prep_2_attack",
  "prep_3_attack",
  "combo_pattern_1bar",
  "combo_pattern_2bar",
];

export const candidateSceneFamilyMeta: Record<CandidateSceneFamily, { label: string; description: string }> = {
  reactive: {
    label: "반응형",
    description: "준비 박 1~3개 뒤 마지막 한 번을 치는 전투형 입력 후보입니다.",
  },
  pattern: {
    label: "패턴형",
    description: "앞의 예시와 뒤의 입력 박자를 동일하게 복제해서 따라치게 하는 패턴 후보입니다.",
  },
};

export const candidateSceneTypeMeta: Record<
  CandidateSceneType,
  {
    family: CandidateSceneFamily;
    label: string;
    shortLabel: string;
    description: string;
    laneLabel: string;
  }
> = {
  prep_1_attack: {
    family: "reactive",
    label: "준비 1회 후 공격",
    shortLabel: "준1공",
    description: "한 번의 준비 박 뒤 마지막 한 번을 입력하는 반응형 문법입니다.",
    laneLabel: "준비 1회",
  },
  prep_2_attack: {
    family: "reactive",
    label: "준비 2회 후 공격",
    shortLabel: "준2공",
    description: "두 번의 준비 박 뒤 마지막 한 번을 입력하는 반응형 문법입니다.",
    laneLabel: "준비 2회",
  },
  prep_3_attack: {
    family: "reactive",
    label: "준비 3회 후 공격",
    shortLabel: "준3공",
    description: "세 번의 준비 박이 쌓인 뒤 마지막 한 번을 입력하는 긴 반응형 문법입니다.",
    laneLabel: "준비 3회",
  },
  combo_pattern_1bar: {
    family: "pattern",
    label: "1마디 동일 패턴",
    shortLabel: "1마디",
    description: "1마디 예시를 먼저 들려주고 다음 1마디에서 같은 박자를 그대로 입력하는 패턴입니다.",
    laneLabel: "1마디 패턴",
  },
  combo_pattern_2bar: {
    family: "pattern",
    label: "2마디 동일 패턴",
    shortLabel: "2마디",
    description: "2마디 예시를 먼저 들려주고 다음 2마디에서 같은 박자를 그대로 입력하는 패턴입니다.",
    laneLabel: "2마디 패턴",
  },
};
