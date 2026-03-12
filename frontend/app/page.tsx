import { UploadWorkbench } from "@/components/upload-workbench";

export default function Home() {
  return (
    <main className="page-shell">
      <section className="hero-block">
        <p className="eyebrow">Rhythm Game BGM Analysis</p>
        <h1>리듬게임 BGM 분석</h1>
        <p className="hero-copy">
          BPM, offset, song length를 먼저 확인하고, 그 위에 이벤트 후보를 검토할 수 있는 최소 작업
          화면입니다.
        </p>
        <div className="hero-note">
          분석 후에는 정박, 8분, 16분 기준으로 쪼개진 후보 이벤트를 타임라인에서 확대해서 보고, 효과음을
          겹쳐 들으면서 직접 정리할 수 있습니다.
        </div>
      </section>

      <UploadWorkbench />
    </main>
  );
}
