import type { AnalysisResponse, CandidateStrategy, CandidateVariant } from "@/lib/types";

export const candidateStrategyOrder: CandidateStrategy[] = ["reactive", "pattern", "hybrid"];

const fallbackVariantMeta: Record<CandidateStrategy, Pick<CandidateVariant, "label" | "description">> = {
  reactive: {
    label: "반응형",
    description: "준비 박 1~3개 뒤 마지막 한 번을 치는 반응형 후보만 모아 봅니다.",
  },
  pattern: {
    label: "패턴형",
    description: "앞의 예시와 뒤의 입력이 동일한 1~2마디 패턴 후보만 모아 봅니다.",
  },
  hybrid: {
    label: "반응형 + 패턴형",
    description: "동일 패턴 구간과 준비-공격 구간을 함께 섞어 곡 흐름을 비교합니다.",
  },
};

export function getCandidateStrategyLabel(strategy: CandidateStrategy) {
  return fallbackVariantMeta[strategy].label;
}

export function getCandidateVariants(analysis: AnalysisResponse) {
  if (analysis.candidateVariants.length > 0) {
    return analysis.candidateVariants.map((variant) => ({
      ...variant,
      label: fallbackVariantMeta[variant.strategy].label,
      description: fallbackVariantMeta[variant.strategy].description,
    }));
  }

  const fallbackStrategy = analysis.defaultCandidateStrategy ?? "hybrid";

  return [
    {
      strategy: fallbackStrategy,
      label: fallbackVariantMeta[fallbackStrategy].label,
      description: fallbackVariantMeta[fallbackStrategy].description,
      candidateEvents: analysis.candidateEvents,
      patternSegments: [],
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
    defaultCandidateStrategy: analysis.defaultCandidateStrategy ?? "hybrid",
    candidateEvents: variant.candidateEvents,
    candidateVariants: getCandidateVariants(analysis),
  };
}
