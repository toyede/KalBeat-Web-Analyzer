# KalBeat Web Analyzer

KalBeat Web Analyzer는 리듬게임용 BGM을 업로드하면 `BPM`, `offset`, `song length`를 추정하고, 그 위에 게임 플레이에 쓸 수 있는 후보 이벤트를 제안하는 웹 기반 분석 도구다.

현재 구현의 목적은 완성 채보를 자동으로 만들어 주는 것이 아니라, Unity 채보 작업 전에 사람이 빠르게 듣고, 보고, 고를 수 있는 후보 이벤트를 정리해 주는 것이다. 그래서 분석 결과는 정답이라기보다 "채보 초안 생성을 위한 후보 제안"에 가깝다.

## 현재 구현 범위

- `wav`, `mp3` 오디오 업로드
- `BPM`, `offset`, `song length` 추정
- 반응형, 패턴형, 혼합형 후보 전략 비교
- 준비 박 후 공격, 1마디/2마디 동일 패턴 등 플레이 문법 기준 후보 분류
- 파형 기반 타임라인 시각화
- 후보 이벤트, 패턴 제시 구간, 입력 응답 구간 표시
- 타임라인 줌, 이동, 선택 이벤트 위치 이동
- 원본 음원 위에 효과음 또는 합성 클릭을 겹쳐 듣는 미리듣기
- 전체 후보, 현재 씬 타입, 선택 이벤트 단위 재생
- 이벤트별 `검토 전 / 채용 / 제외` 상태 정리
- 브라우저 로컬 저장본 생성, 복원, 삭제
- 프로젝트 JSON 및 채용 이벤트 JSON 내보내기

## 사용한 기술

### Frontend

- `Next.js 15`
- `React 19`
- `TypeScript`
- 브라우저 `Web Audio API`
- 브라우저 `IndexedDB`

### Backend

- `FastAPI`
- `Pydantic`
- `librosa`
- `numpy`
- `scipy`
- `soundfile`
- `python-multipart`

## 프로젝트 구조

```text
backend/
  app/
    config.py
    main.py
    schemas.py
    services/
      analysis.py
  requirements.txt
  run-dev.ps1

frontend/
  app/
  components/
  lib/
  package.json

start-local.ps1
stop-local.ps1
web_analyzer_handoff.md
```

## 분석 파이프라인

### 1. 오디오 로딩과 리샘플링

업로드된 오디오는 `soundfile`로 읽는다. 스테레오 파일은 mono로 평균 변환하고, 내부 분석 기준을 맞추기 위해 `scipy.signal.resample_poly`로 `22.05kHz`에 맞춰 리샘플링한다.

입력 파일마다 샘플레이트가 달라도 뒤쪽 분석 로직이 같은 시간 해상도에서 동작하게 만드는 단계다.

### 2. 퍼커시브 성분 분리

`librosa.effects.hpss`를 사용해서 전체 신호에서 퍼커시브 성분을 분리한다.

리듬게임용 후보 이벤트는 멜로디의 음정보다 타격성 변화, 드럼 어택, 강한 onset에 더 많이 의존하므로, 분석 입력을 퍼커시브 신호 중심으로 잡는다.

### 3. Onset Envelope 생성

`librosa.onset.onset_strength`로 onset envelope를 만든다.

이 값은 시간축에서 "지금 타격성 변화가 얼마나 강한가"를 나타내며, BPM 추정, beat grid 생성, 후보 confidence 계산의 공통 입력으로 쓰인다.

### 4. BPM 추정

`librosa.beat.beat_track`으로 beat frame을 먼저 구하고, beat 간격의 median으로 BPM을 다시 계산한다.

계산된 값이 정수 BPM에 매우 가까우면 스냅해서 `110.0`, `128.0`처럼 차트 작업에서 쓰기 좋은 값으로 보정한다.

핵심 아이디어:

- beat tracker 결과를 그대로 쓰지 않고 beat 간격 기반 median으로 다시 계산
- 정수 BPM 근처의 작은 오차는 사람이 쓰기 좋은 값으로 보정

### 5. Offset 추정

첫 beat와 첫 onset을 비교해서 offset을 정한다.

- beat가 충분히 잡히면 첫 beat를 기본값으로 사용
- 첫 onset이 그보다 조금 앞에 있고 자연스러운 범위에 있으면 onset을 offset으로 채택
- beat가 부족한 파일은 onset 기반으로 fallback

현재 offset은 "첫 번째 의미 있는 리듬 진입점"을 고르는 휴리스틱에 가깝다.

### 6. 기본 후보 소스 생성

beat를 기준으로 여러 timing role의 격자를 만든 뒤, 각 격자 주변의 onset envelope local peak를 찾는다.

현재 사용하는 timing role:

- `pulse`: 기본 정박
- `offbeat`: 8분 오프비트
- `subdivision`: 16분 분할
- `thirtySecond`: 32분 분할
- `triplet`: 셋잇단/셔플 성향
- `freeAccent`: 현재 beat grid 바깥에서 강하게 튀는 onset

각 후보의 confidence는 local peak의 상대 강도와 grid 중심에 가까운 정도를 함께 반영한다.

```text
confidence = normalized_strength * 0.72 + closeness * 0.28
```

격자 후보와 별도로, beat grid에 잘 붙지 않지만 강하게 튀는 onset은 `freeAccent` 후보로 따로 남긴다.

### 7. 드럼/타격감 보조 곡선

퍼커시브 신호의 STFT magnitude를 low, mid, high 대역으로 나누고, 각 대역의 positive flux를 계산한다. 이후 smoothing과 normalization을 거쳐 다음 곡선을 만든다.

- low curve
- mid curve
- high curve
- accent curve

이 곡선은 단순 onset 세기만으로는 부족한 타격감, 저역 임팩트, 스냅감을 후보 점수에 반영하기 위해 사용한다.

## 후보 제안 추출 방식의 변화

이 프로젝트의 핵심 변화는 단순히 이벤트 개수를 늘리는 방향이 아니라, "어떤 기준으로 리듬게임용 후보를 제안할 것인가"를 계속 구체화해 온 과정이다.

### 1. 고정 박자 그리드 기반 후보 추출

초기 구현(`47ab5b2`)에서는 BPM과 offset을 먼저 추정한 뒤, beat를 4분할한 고정 그리드 위에서 후보 이벤트를 찾았다.

- `slot 0`: 정박
- `slot 2`: 8분 오프비트
- `slot 1, 3`: 16분 세분

각 그리드 위치 주변의 onset envelope local peak를 찾고, peak의 세기와 그리드 중심에 가까운 정도를 합쳐 confidence를 계산했다. 이 시점의 후보는 `downbeat`, `beat`, `offbeat`, `subdivision`처럼 박자 역할 중심으로 분류됐다.

즉, 처음 방식은 "음악에서 강하게 튀는 지점"을 "박자 격자 위에 많이 표시하는" 구조였다.

### 2. 전곡 기준과 4마디 구간 기준의 분리

이후 기능 추가(`e963663`)에서 후보 추출 기준이 두 가지로 나뉘었다.

- `global`: 곡 전체 onset 세기를 하나의 기준으로 평가
- `section4bar`: 4마디 단위로 onset 기준 세기를 다시 계산

전곡 기준만 쓰면 큰 드롭이나 강한 후렴 구간에 후보가 몰리고, 조용한 구간의 상대적인 악센트가 묻힐 수 있다. 그래서 4마디 단위 reference strength를 추가해, 구간 안에서 의미 있는 후보도 살아남게 만들었다.

이 단계에서 후보 역할도 확장됐다.

- `pulse`
- `offbeat`
- `subdivision`
- `thirtySecond`
- `triplet`
- `freeAccent`

특히 `freeAccent`는 기존 박자 격자에 잘 맞지 않지만 onset이 강한 지점을 따로 잡기 위해 추가됐다. 이때부터 후보 추출은 단순 4분할 그리드가 아니라, 32분/셋잇단/격자 밖 악센트까지 포함하는 더 넓은 후보 수집 방식으로 바뀌었다.

### 3. 그룹 선택과 검토 상태의 연결

후보 그룹 선택 구현(`a55f710`)에서는 추출 알고리즘 자체보다, 후보를 검토하는 방식이 개선됐다. timing role별 그룹을 켜고 끌 수 있게 만들고, 켜진 그룹은 기본적으로 `채용`, 꺼진 그룹은 `검토 전`으로 연결했다.

이 변화는 후보 추출 결과를 사람이 빠르게 걸러내기 위한 단계였다. 즉, 알고리즘이 후보를 넓게 뽑고, 사용자가 박자 역할 단위로 1차 필터링하는 구조가 됐다.

### 4. 박자 역할 중심에서 플레이 문법 중심으로 전환

가장 큰 변화는 `fd8c404`에서 이루어졌다. 기존의 `global / section4bar` 비교 방식은 내부 후보 소스 생성 방식으로 내려가고, 사용자에게 보이는 전략은 아래 세 가지로 바뀌었다.

- `reactive`: 준비 박 뒤 마지막 입력으로 반응하는 후보
- `pattern`: 앞의 리듬을 듣고 다음 1~2마디에서 따라치는 후보
- `hybrid`: 패턴형 구간을 우선 배치하고 남는 곳에 반응형 후보를 채운 후보

이 변화로 후보는 더 이상 단순히 `정박`, `오프비트`, `세분박` 같은 박자 역할만 의미하지 않는다. 이제 후보에는 `sceneFamily`, `sceneType`, `sceneGroupId`, `cueTimesSec`가 붙고, 어떤 게임 플레이 문법에 쓰일 후보인지까지 함께 기록된다.

### 5. 반응형 후보 추출

반응형 후보는 16분 슬롯 기준으로 좋은 후보를 고른 뒤, 준비 박 1~3개가 마지막 공격으로 이어지는 구조를 찾는다.

점수에는 다음 요소가 반영된다.

- 후보 자체의 confidence와 strength
- 주변 후보 대비 local accent 정도
- 드럼/타격감 곡선의 accent, low, snap 점수
- cue 간격이 일정한지
- 마지막 입력이 cue보다 충분히 강하게 느껴지는지
- 정박이나 마디 시작처럼 읽기 쉬운 위치인지

이 결과는 다음 scene type으로 정리된다.

- `prep_1_attack`
- `prep_2_attack`
- `prep_3_attack`

즉, "여기 소리가 강하다"가 아니라 "여기까지 준비하고 마지막에 치면 자연스럽다"는 형태의 후보를 만든다.

### 6. 패턴형 후보 추출

패턴형 후보는 1마디 또는 2마디 cue motif를 찾고, 그 다음 구간에 같은 리듬 구조를 response로 제안한다.

패턴 후보 점수에는 다음 요소가 들어간다.

- 한 구간 안의 후보 밀도
- 후보들의 평균 confidence/strength
- interval variety
- 16분 슬롯 기준 complexity
- pulse가 아닌 후보 비율
- 드럼 snap 성향
- response 구간에 실제 onset support가 있는지

선택된 패턴은 `PatternSegment`로 기록된다.

- cue 구간
- response 구간
- cue 이벤트 목록
- response 이벤트 id 목록
- score
- similarity

이 구조 덕분에 패턴형 후보는 "입력해야 할 지점"만 보여주는 것이 아니라, "무엇을 듣고 따라쳐야 하는지"까지 같이 보여준다.

### 7. 하이브리드 후보 조합

현재 기본 전략은 `hybrid`다. 하이브리드는 먼저 패턴형 후보가 차지하는 cue/response 마디를 예약하고, 그 마디와 겹치지 않는 곳에 반응형 후보를 채운다.

이렇게 한 이유는 패턴형 후보와 반응형 후보가 같은 구간에 과하게 겹치면 실제 채보 후보로 보기 어렵기 때문이다. 그래서 반복 패턴이 분명한 구간은 패턴형으로, 나머지 순간적인 악센트는 반응형으로 제안하는 방식으로 정리했다.

결과적으로 후보 추출 방식은 다음 흐름으로 발전했다.

1. 고정 박자 그리드에서 onset peak를 찾는 방식
2. 전곡 기준과 4마디 기준을 나눠 상대적 악센트를 보존하는 방식
3. 32분, 셋잇단, 자유 악센트까지 포함해 후보 수집 범위를 넓힌 방식
4. timing role 후보를 사람이 그룹 단위로 검토하는 방식
5. 반응형/패턴형/하이브리드라는 플레이 문법 중심 후보 제안 방식

현재 구현은 단순 onset 검출기가 아니라, 리듬게임에서 "언제 입력하면 자연스러운가"와 "어떤 플레이 문법으로 쓰기 좋은가"를 함께 제안하는 구조로 발전한 상태다.

## 프론트엔드 상호작용 구현

### 파형 시각화

업로드한 원본 파일은 브라우저에서 `AudioContext.decodeAudioData`로 다시 디코딩하고, 일정 구간 단위 peak를 계산해서 파형 막대로 그린다.

즉, 파형은 백엔드가 내려주는 데이터가 아니라 프론트엔드가 직접 만든 시각화다.

### 타임라인 레인

타임라인은 후보를 scene type 기준 레인으로 나누어 표시한다.

- 준비 1회 후 공격
- 준비 2회 후 공격
- 준비 3회 후 공격
- 1마디 동일 패턴
- 2마디 동일 패턴

패턴형 후보는 cue 구간과 response 구간을 서로 다른 배경 막대로 보여 주고, cue marker와 실제 입력 marker를 함께 표시한다.

### 줌과 이동

타임라인은 컨텐츠 폭을 늘리는 방식으로 확대하고, 수평 스크롤과 이동 슬라이더를 함께 사용한다.

선택 이벤트 위치로 바로 이동할 수 있어서, 긴 곡에서도 특정 후보 주변의 파형과 마커를 빠르게 비교할 수 있다.

### 미리듣기

미리듣기는 서버에서 새 오디오 파일을 만들어 내려주는 방식이 아니라, 브라우저에서 `Web Audio API`로 원본 음원과 효과음을 같은 타임라인 위에 스케줄링하는 방식이다.

- 원본 음악 버퍼 재생
- 후보 이벤트 시간에 맞춰 효과음 버퍼 또는 합성 클릭 재생
- 패턴 cue와 입력 이벤트에 서로 다른 pitch 적용
- 원본 볼륨과 효과음 볼륨 개별 조절
- 전체 후보 재생
- 현재 씬 타입 재생
- 선택 이벤트 재생

## 저장과 내보내기

### 로컬 저장

프로젝트 저장은 브라우저 `IndexedDB`에 저장된다. 저장본에는 분석 결과, 검토 상태, 활성 후보 전략, 선택 이벤트, 원본 오디오 Blob이 포함될 수 있다.

저장본을 복원하면 분석 결과와 선택 상태뿐 아니라, 저장 당시 포함된 오디오 파일도 다시 `File` 객체로 복원해 타임라인 미리듣기에 사용할 수 있다.

### 프로젝트 JSON 내보내기

프로젝트 JSON은 현재 작업 상태 전체를 저장하기 위한 포맷이다. 분석 결과, 검토 상태, 선택 전략, 선택 이벤트가 포함되지만 오디오 바이너리는 포함하지 않는다.

### 결과 JSON 내보내기

결과 JSON은 `채용`으로 분류한 이벤트만 골라 Unity 또는 후속 채보 작업에서 쓰기 위한 포맷이다.

포함되는 주요 값:

- song id/name/audio file name
- global BPM
- offset
- song length
- 활성 후보 전략
- 활성 timing role 목록
- 채용 이벤트 목록
- timing role별 채용 개수

## 주요 파일

- `backend/app/services/analysis.py`
  - 오디오 분석 파이프라인, 후보 소스 생성, 반응형/패턴형/하이브리드 후보 생성
- `backend/app/schemas.py`
  - FastAPI 응답 스키마와 후보 이벤트 타입
- `backend/app/main.py`
  - 업로드 API, 파일 검증, 분석 실행 엔드포인트
- `frontend/components/upload-workbench.tsx`
  - 업로드, 분석 요청, 후보 전략 선택, 저장/복원/내보내기 상태 관리
- `frontend/components/analysis-timeline.tsx`
  - 파형, 씬 레인, cue/response 표시, 미리듣기
- `frontend/components/candidate-events-panel.tsx`
  - 후보 목록, 패턴 세그먼트 요약, 검토 상태 UI
- `frontend/lib/project-io.ts`
  - IndexedDB 저장/복원, JSON 내보내기, 저장본 정규화
- `frontend/lib/candidate-strategy.ts`
  - 후보 전략 선택과 fallback 처리
- `frontend/lib/candidate-scene-meta.ts`
  - scene family/type 메타데이터
- `frontend/lib/candidate-event-meta.ts`
  - timing role 메타데이터

## 현재 한계

- 자동 완성 채보가 아니라 후보 제안과 수동 검토 중심이다.
- Unity 쪽 현재 구조를 고려해 아직 단일 BPM/offset 중심으로 동작한다.
- BPM 변화 구간, 섹션 구조, stem separation은 아직 정식 구현되어 있지 않다.
- 악기별 분리 없이 퍼커시브 신호와 대역별 flux 기반 타격감만 사용한다.
- 저장본은 브라우저 로컬 IndexedDB에 있으므로 브라우저나 기기가 바뀌면 자동 공유되지 않는다.

## 요약

현재 구현은 다음 두 가지를 중심으로 설계되어 있다.

- 오디오에서 리듬적으로 의미 있는 지점을 넓게 수집한다.
- 수집한 지점을 반응형, 패턴형, 하이브리드라는 플레이 문법으로 재해석해 사람이 빠르게 검토할 수 있게 만든다.

즉, KalBeat Web Analyzer는 "완성 채보 생성기"보다 "리듬게임용 후보 이벤트 분석기"에 더 가깝다.
