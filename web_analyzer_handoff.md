# KalBeat Web Analyzer Handoff

## 1. 목적
- 업로드한 음악 파일을 분석해서 리듬게임 채보 작업에 바로 쓸 수 있는 보조 데이터를 만든다.
- 웹사이트에서 초벌 분석을 수행하고, Unity 채보 에디터에서 후반 수동 편집을 이어서 한다.
- Unity 런타임의 정본은 FMOD 재생 시간 기반이며, 웹 분석 결과는 채보 제작 보조 도구로 사용한다.

## 2. 왜 Unity 프로젝트와 분리해야 하는가
- 웹 앱은 `Node.js/Next.js` 또는 유사 프론트엔드 런타임, 백엔드 API, Python 분석 워커가 함께 필요할 가능성이 높다.
- 오디오 분석 라이브러리, ML 모델, 가상환경, `node_modules`, 캐시, 업로드 파일은 Unity 프로젝트에 불필요한 잡음을 만든다.
- Unity는 프로젝트 루트 변화를 민감하게 감시하므로, 웹 빌드 산출물과 의존성이 들어오면 에셋 리프레시와 작업 속도에 악영향이 날 수 있다.
- 배포, 로그, 업로드 스토리지, 작업 큐는 게임 프로젝트와 수명 주기가 다르다.

## 3. 권장 폴더 구조
- 권장: Unity 프로젝트와 같은 상위 폴더 아래에 형제 폴더로 분리

```text
C:\Users\owner\Documents\UnityProject\
  Kal_Beat\                # 현재 Unity 프로젝트
  KalBeat.WebAnalyzer\     # 새 웹 분석 프로젝트
```

- 대안: 완전 별도 저장소로 분리
- 비권장: 현재 `Kal_Beat` 루트 안에 웹 앱을 직접 추가

## 4. 분석 기능 요구사항
### 필수
- 오디오 업로드
- 전체 BPM 추정
- 첫 다운비트 기준 오프셋 추정
- 마디 구분
- 비트/다운비트 타임라인 추출
- BPM 변화 구간 탐지
- 섹션 구조 분석
  - intro
  - verse
  - chorus
  - bridge
  - outro
- 박자 구조 분석
  - 4/4 중심 여부
  - 강박/약박 패턴
  - 스윙/셔플 경향
- 채보 보조용 후보 박자 포인트 추출

### 고급
- 악기 세션별 분리
  - drums
  - bass
  - vocal
  - other
- 세션별 onset 후보 추출
- 킥/스네어/하이햇 중심 리듬 패턴 추정
- 에너지 변화 기반 하이라이트 구간 탐지

### 주의
- 악기별 분리와 복잡한 리듬 구조 분석은 ML 기반 추론이 필요하며 100% 정확하지 않다.
- "정답 자동 채보기"보다는 "유력 후보 제시 + 수동 보정" 방향이 현실적이다.

## 5. 권장 기술 구성
### 프론트엔드
- Next.js 또는 React
- 업로드 UI
- 파형, 비트, 마디, 섹션, 템포맵 시각화
- 분석 결과 수동 보정 UI

### 백엔드
- Python FastAPI 권장
- 이유: 오디오 분석 생태계가 가장 풍부함

### 분석 스택 후보
- `librosa`: onset, tempo, beat tracking, spectral feature
- `madmom`: beat/downbeat tracking
- `essentia`: 템포/리듬 특징 분석
- `demucs` 또는 `spleeter`: stem separation
- `ffmpeg`: 디코딩/포맷 변환

### 운영
- 업로드 파일 저장소
- 분석 작업 큐
- 긴 작업 상태 폴링 또는 SSE
- 캐시된 분석 결과 재사용

## 6. Unity 현재 구조에서 반드시 알아야 할 점
- 현재 채보 메타는 단일 BPM과 단일 Offset 구조다.
- 현재 채보 에디터는 `BPM`, `OffsetSec`, `SongLengthSec`, `GridDivision`을 수동 메타로 편집한다.
- 현재 미리보기 시간과 beat 변환은 단일 BPM 공식으로 계산된다.
- 따라서 웹에서 BPM 변화까지 분석하더라도, Unity 쪽은 아직 멀티 BPM을 저장/편집/표시하지 못한다.

### 관련 파일
- `Assets/Scripts/Runtime/Chart/ChartMeta.cs`
- `Assets/Scripts/Editor/ChartEditorWindow.cs`
- `Assets/Scripts/Runtime/Chart/ChartValidator.cs`
- `docs/game_design.md`

## 7. Unity 연동을 위한 1차 결과 포맷 제안
- 웹사이트는 Unity가 직접 읽기 쉬운 JSON을 내보낸다.
- Unity는 이 JSON을 임포트해서 `ChartData` 메타 초안과 보조 마커를 생성한다.

### JSON 예시
```json
{
  "schemaVersion": 1,
  "songId": "example_song",
  "songName": "Example Song",
  "audioFileName": "example_song.wav",
  "analysisVersion": "2026-03-10",
  "globalBpm": 128.0,
  "offsetSec": 0.184,
  "songLengthSec": 121.532,
  "timeSignature": {
    "numerator": 4,
    "denominator": 4
  },
  "tempoMap": [
    { "beatStart": 0.0, "timeSec": 0.184, "bpm": 128.0 },
    { "beatStart": 128.0, "timeSec": 60.250, "bpm": 132.0 }
  ],
  "downbeats": [
    { "bar": 1, "beat": 0.0, "timeSec": 0.184 },
    { "bar": 2, "beat": 4.0, "timeSec": 2.059 }
  ],
  "beats": [
    { "beat": 0.0, "timeSec": 0.184, "strength": 1.0 },
    { "beat": 1.0, "timeSec": 0.653, "strength": 0.5 }
  ],
  "sections": [
    { "name": "intro", "startBeat": 0.0, "endBeat": 16.0 },
    { "name": "verse", "startBeat": 16.0, "endBeat": 48.0 }
  ],
  "stems": [
    {
      "name": "drums",
      "onsets": [
        { "timeSec": 0.184, "confidence": 0.92, "kind": "kick" },
        { "timeSec": 0.653, "confidence": 0.85, "kind": "snare" }
      ]
    }
  ],
  "chartHints": [
    {
      "beat": 8.0,
      "lane": 0,
      "eventType": "AttackTiming",
      "confidence": 0.74,
      "source": "drum_peak"
    }
  ]
}
```

## 8. Unity 1차 임포트 범위 제안
### 당장 바로 쓸 수 있는 것
- `globalBpm` -> `ChartMeta.Bpm`
- `offsetSec` -> `ChartMeta.OffsetSec`
- `songLengthSec` -> `ChartMeta.SongLengthSec`
- `chartHints` -> `ChartEventData` 후보 생성

### 당장은 참고용으로만 저장할 것
- `tempoMap`
- `downbeats`
- `sections`
- `stems`

### 이유
- 현재 Unity 채보 구조는 멀티 BPM과 섹션/스템 데이터를 정식 필드로 저장하지 않는다.
- 그래서 1단계는 JSON 보관 + 일부 메타 자동 반영 정도가 적절하다.

## 9. 웹 프로젝트에서 먼저 구현할 MVP
1. 오디오 업로드
2. 단일 BPM 추정
3. offset/downbeat 추정
4. 마디선/비트선 시각화
5. BPM 변화 의심 구간 표시
6. JSON 내보내기

## 10. 2단계 기능
1. stem separation
2. 드럼 기반 채보 힌트 생성
3. 섹션 분류
4. 수동 보정 UI
5. Unity import preset 맞춤 내보내기

## 11. 새 웹 프로젝트에 넘겨야 할 핵심 도메인 규칙
- 리듬게임의 정본 시간 단위는 beat
- 런타임 싱크 정본은 FMOD 재생 시간
- 채보 메타 필수 필드
  - bpm
  - offsetSec
  - fmodEventPath
- 같은 타임슬롯 최대 이벤트 수는 4
- 이벤트 우선순위
  - AttackTiming
  - MonsterAction
  - CameraMoving
  - CameraCue
- 웹 분석 결과는 자동 완성본이 아니라 채보 초안 생성기 성격

## 12. 새 웹 프로젝트 첫 전달문 예시
아래 내용을 새 프로젝트 README 또는 이슈 1번에 그대로 옮겨도 된다.

```text
프로젝트명: KalBeat.WebAnalyzer

목표:
- 음악 파일을 업로드하면 BPM, offset, downbeat, 마디 구분, 템포 변화, 섹션 구조를 분석한다.
- 분석 결과를 Unity 채보 에디터에서 후속 작업 가능한 JSON으로 내보낸다.

반드시 필요한 기능:
- BPM 추정
- offsetSec 추정
- 마디/다운비트 검출
- BPM 변화 구간 탐지
- 악기 세션 분리(가능하면 drums 우선)
- 채보 힌트 후보 생성

출력 포맷 요구:
- globalBpm
- offsetSec
- songLengthSec
- tempoMap[]
- downbeats[]
- beats[]
- sections[]
- stems[]
- chartHints[]

Unity 제약:
- 현재 Unity 에디터는 단일 BPM/Offset 중심이다.
- 멀티 BPM은 우선 JSON 보조 데이터로만 유지한다.
- 최종 채보는 beat 단위로 편집한다.
```

## 13. Unity 쪽 다음 작업 후보
- JSON 분석 결과를 읽는 `ChartAnalysisImport` 유틸 추가
- `ChartData` 메타 자동 채우기
- `chartHints`를 `None` 또는 `AttackTiming` 후보 이벤트로 배치
- 장기적으로 `tempoMap` 지원을 위한 데이터 구조 확장

## 14. 결론
- 웹 분석 도구는 현재 Unity 프로젝트 안에서 만들기보다, 별도 폴더 또는 별도 저장소로 분리하는 것이 맞다.
- 현재 Unity 구조는 단일 BPM/Offset 중심이라서, 웹 도구의 고급 분석 결과는 우선 JSON 보조 데이터로 넘기는 방식이 가장 안전하다.
