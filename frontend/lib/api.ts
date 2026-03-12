import type { AnalysisResponse } from "@/lib/types";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
const allowedExtensions = new Set([".wav", ".mp3"]);

export const supportedExtensions = [".wav", ".mp3"];

function getExtension(fileName: string) {
  const lastDot = fileName.lastIndexOf(".");

  if (lastDot < 0) {
    return "";
  }

  return fileName.slice(lastDot).toLowerCase();
}

export function validateAudioFile(file: File) {
  const extension = getExtension(file.name);

  if (!allowedExtensions.has(extension)) {
    throw new Error("현재는 .wav와 .mp3 파일만 지원합니다.");
  }
}

export async function analyzeAudio(file: File) {
  validateAudioFile(file);

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${apiBaseUrl}/api/analyze`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    let detail = "분석 요청에 실패했습니다.";

    try {
      const payload = (await response.json()) as { detail?: string };
      detail = payload.detail ?? detail;
    } catch {
      detail = "서버가 읽을 수 없는 오류를 반환했습니다.";
    }

    throw new Error(detail);
  }

  return (await response.json()) as AnalysisResponse;
}
