import type { AnalysisResponse, CandidateStrategy, CandidateVariant } from "@/lib/types";

export const candidateStrategyOrder: CandidateStrategy[] = ["global", "section4bar"];

const fallbackVariantMeta: Record<CandidateStrategy, Pick<CandidateVariant, "label" | "description">> = {
  global: {
    label: "전곡 기준",
    description: "곡 전체 onset 에너지를 한 기준으로 보고 후보를 추출합니다.",
  },
  section4bar: {
    label: "4마디 기준",
    description: "4마디 단위로 onset 세기를 다시 평가해 조용한 구간의 상대 강세를 더 반영합니다.",
  },
};

export function getCandidateVariants(analysis: AnalysisResponse) {
  if (analysis.candidateVariants.length > 0) {
    return analysis.candidateVariants;
  }

  return [
    {
      strategy: analysis.defaultCandidateStrategy ?? "global",
      label: fallbackVariantMeta.global.label,
      description: fallbackVariantMeta.global.description,
      candidateEvents: analysis.candidateEvents,
    },
  ];
}

export function getCandidateVariant(analysis: AnalysisResponse, strategy: CandidateStrategy) {
  const variants = getCandidateVariants(analysis);

  return (
    variants.find((variant) => variant.strategy === strategy) ??
    variants.find((variant) => variant.strategy === analysis.defaultCandidateStrategy) ??
    variants[0]
  );
}

export function createAnalysisForStrategy(analysis: AnalysisResponse, strategy: CandidateStrategy): AnalysisResponse {
  const variant = getCandidateVariant(analysis, strategy);

  return {
    ...analysis,
    defaultCandidateStrategy: analysis.defaultCandidateStrategy ?? "global",
    candidateEvents: variant.candidateEvents,
    candidateVariants: getCandidateVariants(analysis),
  };
}
