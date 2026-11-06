---
title: ApiChkKit
emoji: ✅
colorFrom: indigo
colorTo: red
sdk: static
pinned: false
app_build_command: npm run build
app_file: build/index.html
license: mit
short_description: URL → API 분석, 조건값별 결과값 확인 키트
---

# API Check Kit

URL을 입력하면 **그 사이트가 어떤 API를 사용하는지** 찾아내고, 각 API에 **어떤 조건값(요청 파라미터)을 넣으면 어떤 결과값(응답 필드)을 받을 수 있는지** 정리·테스트하는 정적 웹앱입니다.

- 데모: https://huggingface.co/spaces/Sangmoo/apiChkKit
- 소스: https://github.com/Sangmoo/apiChkKit

## 주요 기능

| 단계 | 내용 |
|---|---|
| **1. API 수집** | URL 정적 분석, 캡처 스크립트, HAR 업로드, cURL 붙여넣기, OpenAPI 스펙 |
| **2. 조건값 → 결과값** | 엔드포인트별 query / path / header / body 파라미터(타입·필수 여부·예시·관측값·허용값)와 응답 필드(경로·타입·예시값)를 표로 정리 |
| **3. 테스트** | 조건값을 바꿔 바로 호출하고 응답을 JSON 트리, 결과 필드, Raw, 헤더로 확인. 받은 응답은 응답 구조에 자동으로 합쳐집니다 |
| **4. 조건 비교** | 파라미터 하나를 여러 값(자동 제안: 관측값, enum, 경계값, 파라미터 제외)으로 바꿔 호출하고 상태코드, 결과 개수, 응답 구조 변화를 비교 |
| **5. 내보내기** | Markdown 리포트, OpenAPI 3 스펙, 프로젝트 JSON(저장/불러오기), cURL / fetch / Python 코드 |

### URL 분석이 하는 일

1. URL 응답 종류 판별
   - **OpenAPI/Swagger 문서**(JSON·YAML)면 모든 엔드포인트, 파라미터, 응답 스키마를 파싱합니다 (`$ref`, `allOf` 처리)
   - **WordPress REST 인덱스**(`/wp-json`)면 라우트와 args를 파싱합니다
   - **GraphQL 엔드포인트**면 introspection으로 query/mutation과 변수를 조회합니다
   - **JSON/XML API 응답**이면 쿼리 파라미터와 응답 구조를 추론합니다
2. **HTML 페이지**면 다음을 분석합니다
   - `<form>` 의 action, method, 입력 필드(select 옵션은 허용값으로)
   - 인라인 스크립트와 `data-*-url`, `hx-get` 등의 속성
   - 외부 JS 번들(최대 25개, 동적 청크 1단계까지) 안의 `fetch()`, `axios.get/post`, `$.ajax`, `XMLHttpRequest.open`, `url:` 설정, API 형태의 문자열. 템플릿 리터럴 `${id}` 는 path 파라미터로, 호출부의 `params: {…}`, `body: JSON.stringify({…})` 키는 조건값으로 추출합니다
   - Next.js `__NEXT_DATA__`, WordPress `api.w.org` 링크
   - `/openapi.json`, `/v3/api-docs`, `/swagger.json` 같은 스펙 경로 자동 탐색

정적 분석 결과는 신뢰도(**확실**: 스펙·실제 관측 / **추정**: 코드 문맥 / **약한 추정**: 문자열 패턴)와 발견 근거(소스 코드 스니펫)를 함께 보여줍니다.

### 캡처 스크립트 (가장 정확)

페이지가 런타임에 호출하는 API를 그대로 수집합니다. CORS 제한이 없고, 로그인된 상태의 요청도 볼 수 있습니다.

1. **🎯 캡처 스크립트** 탭에서 스크립트를 복사합니다
2. 분석할 사이트에서 F12 → Console 탭에 붙여넣고 실행합니다
3. 검색, 필터, 페이지 이동 등을 해 봅니다
4. `__ackDone()` 을 실행하면 결과가 클립보드로 복사됩니다. 앱에 붙여넣으면 됩니다

같은 경로의 요청은 `/users/123` → `/users/{userId}` 처럼 묶고, 요청마다 달라진 조건값과 응답 필드를 합칩니다. 모든 요청에 등장한 파라미터는 필수로 표시합니다.

## CORS와 프록시

HF Static Space는 서버가 없는 정적 웹앱이라 모든 요청을 브라우저에서 보냅니다. 대상 서버가 CORS를 허용하지 않으면 직접 호출이 막힙니다.

- 호출 방식 **자동**(기본값): 직접 호출을 먼저 하고, 실패하면 프록시로 다시 시도합니다
- **개인 프록시(권장)**: [`proxy/worker.js`](proxy/worker.js) 를 Cloudflare Workers에 배포한 뒤(무료) ⚙️ 설정에 `https://<worker>.workers.dev/?url={url}` 를 입력합니다
- **공개 프록시**: codetabs, allorigins를 순서대로 시도합니다. 불안정하고 속도 제한이 있으니 민감한 데이터는 보내지 마세요
- 캡처 스크립트, HAR, cURL, OpenAPI 가져오기는 프록시 없이 동작합니다

## 로컬 개발

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 파서/스캐너 단위 테스트
npm run build    # build/ 에 정적 파일 생성 (HF Space가 이 명령으로 빌드)
```

## 구조

```
src/
  App.jsx                    상태, 가져오기, 내보내기
  components/
    InputPanel.jsx           URL / 캡처 / HAR / cURL / 스펙 입력
    EndpointList.jsx         엔드포인트 목록 (검색, 신뢰도 필터)
    EndpointDetail.jsx       조건값→결과값, 테스트, 조건 비교, 기록, 코드, 근거
    SettingsModal.jsx        네트워크/프록시 설정
    common.jsx               JSON 트리, 스키마 테이블 등
  lib/
    analyzer.js              URL 분석 파이프라인, WordPress, GraphQL introspection
    jsScanner.js             JS/HTML 정적 분석
    openapi.js               OpenAPI 파싱 및 내보내기
    importers.js             HAR / 캡처 / cURL 파서
    endpoint.js              엔드포인트 모델, 경로 일반화, 병합
    schema.js                응답 스키마 추론과 병합
    builder.js               요청 조립, 코드 스니펫, 값 제안
    net.js                   직접/프록시 호출
    captureScript.js         콘솔 캡처 스크립트
proxy/worker.js              Cloudflare Worker CORS 프록시
```

## 주의

허가받은 대상만 분석하고 테스트하세요. 조건 비교는 실제 요청을 여러 번 보냅니다. 다른 사람의 서비스에 부하를 주거나 이용약관을 어기지 않도록 주의하세요. 입력한 데이터와 분석 결과는 브라우저(localStorage)에만 저장됩니다.

## License

MIT
