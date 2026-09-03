# Setup CLI 독립 실행 계약

상태: 사용자의 2026-09-03 요구를 반영한 현재 제품 기준.
적용: 0.5.0-edge.19 이후.

Setup은 Windows에 설치해 상시 운영하는 프로그램이 아니다. 필요할 때 실행해 Kubernetes의 Console을 준비·설치·검증하고 종료한다.

## 기본 동작에서 금지

- Setup의 LocalAppData/Program Files/사용자 bin/npm global 설치
- 사용자·시스템 PATH, shell profile, 서비스, 예약 작업, 시작 프로그램 등록
- 영구 런타임 캐시와 상주 프로세스
- bootstrap/upgrade의 부수 효과로 os CLI 설치
- 명시적 요청 없는 호스트 인증서 신뢰 등록

## 실행 흐름

`단일 EXE → exact Release 선택 → immutable 메타데이터·크기·SHA-256 검증 → 고유 TEMP에 압축 해제 → CLI 실행 → 자식 종료 대기 → TEMP 정리 → 동일 종료 코드`

Windows 기본은 단일 온라인 실행 파일이다. 모든 런타임이 내장된 오프라인 단일 파일이라고 설명하지 않는다. 네트워크 사용량과 임시 공간을 표시하며 다운로드 실패 시 보안 검증을 낮추지 않는다.

압축형 포터블 폴더는 사전 다운로드·반복 실행을 위한 대안이다. 사용자가 둔 위치에서 직접 실행한다. 약 99MiB Node SEA와 PowerShell/kubectl의 기존 용량은 남는다. 네이티브 경량화는 별도 미완료 과제다.

## 생명주기

정상 완료·명령 실패·처리 가능한 취소 시 이번 실행의 임시 파일을 정리한다. 강제 종료·전원 장애에서는 TEMP 잔여물이 생길 수 있다. 다른 실행이나 프로그램의 디렉터리를 포괄 삭제하지 않는다.

호출자의 cwd와 stdin을 보존한다. registry token을 launcher가 읽거나 기록하지 않는다. lock/receipt는 사용자 작업 결과이며 임시 런타임과 별개다.

`install-cli`와 `bootstrap --trust-local-ca`는 별도 명시적 호스트 변경이다. Kubernetes 변경은 사용자가 실행한 bootstrap/upgrade 등 작업 명령에 한정한다.

## 수용 기준

1. 전역 Setup 설치·PATH 변경 없이 실행한다.
2. Setup 버전·채널은 Console release 선택과 분리한다.
3. digest 오류, unsafe ZIP, 이전 자동 설치 정책 runtime은 실행 전 차단한다.
4. 성공·실패 시 임시 런타임을 정리한다.
5. bootstrap/upgrade는 os CLI를 자동 설치하지 않는다.
6. 온라인 다운로드 비용과 내부 런타임 크기 한계를 숨기지 않는다.
