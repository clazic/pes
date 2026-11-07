# 2단계 백업 형식 (PR3)

- 작성: 2026-11-08, SEL-36
- 입력: [stage-2-linear.md](issues/stage-2-linear.md) PR3, [stage-2-db-guarantees.md](stage-2-db-guarantees.md) 3절, `tests/test_backup_export.test.ts`(계약 명세)
- 상태: PR3 구현 기준. 코드는 `scripts/pes_core/backup.ts`.
- 범위: 로컬 SQLite와 객체 폴더. D1·원격 저장소·실제 프로젝트는 범위 밖이다.

## 1. 묶음 배치

```text
<bundle>/
  manifest.json
  rows/project.json      프로젝트 행(JSON)
  objects/<storage_key>  blobs 행마다의 불투명 바이트 사본
```

- `out_dir`은 없거나 비어 있어야 한다. 아니면 `BackupError("out_dir_not_empty")`이고 아무것도 쓰지 않는다.
- 없는 `project_id`는 `BackupError("project_not_found")`이고 `out_dir`을 만들지 않는다.
- 행은 **하나의 `tx()` 안에서** 읽는다. DB 파일 복사·`VACUUM INTO`·`ATTACH`·`wal_checkpoint`를 쓰지 않는다. 객체 파일은 행을 읽은 뒤 불투명하게 복사하며, 행 해시와 파일 바이트가 달라도 해석하지 않는다.
- `manifest.json`은 마지막에 쓴다. 쓰기가 실패하면 이번에 만든 파일을 지운다(원래 비어 있던 `out_dir`은 빈 상태로 돌아간다).
- 같은 프로젝트를 두 번 내보내면 파일 바이트까지 같다. 시각·경로 같은 비결정 값은 넣지 않는다.

## 2. manifest 필드

| 필드 | 값 |
|---|---|
| `format_version` | `1` |
| `database_instance_id` | 원본 `db_meta.database_instance_id` |
| `cursor_epoch` | 원본 `db_meta.cursor_epoch`의 10진 문자열 |
| `project_id` | 내보낸 프로젝트 id |
| `files` | `manifest.json`을 뺀 모든 파일의 `{path, sha256, size}`. `path`는 `/` 구분 상대 경로, `sha256`은 소문자 64자, `size`는 바이트 수 |
| `table_counts` | 내보낸 표별 행 수(0행 표는 생략 가능). `users`·`actors`도 포함 |

`rows/project.json`은 `{format_version, project_id, tables:[{name, columns:[{name,type}], rows:[[...]]}]}`이다. 정수는 10진 문자열로 적고, 가져올 때 열 선언 타입이 `INT`이면 `bigint`로 되돌린다. 표는 이름순, 행은 `rowid`순이다.

## 3. 프로젝트 소속 표

표 목록을 코드에 나열하지 않고 스키마에서 정한다.

- `project_id` 열이 있는 모든 표 = `WHERE project_id = ?`
- `projects` = `id = ?` 행 하나
- `users`·`actors` = 프로젝트 행이 FK로 참조하는 사용자·행위자, 그리고 그 사용자에 속한 행위자. 동일 행이 대상 DB에 이미 있으면 건너뛴다.
- `db_meta`는 행으로 내보내지 않는다(식별자·epoch만 manifest에 적는다).

이 규칙이면 뒤 마이그레이션이 `events`·`mutation_commits` 같은 표를 채워도 목록을 고치지 않는다.

## 4. 검증 문제 코드

`verify_bundle`은 던지지 않고 찾은 문제를 전부 모아 `{ok, problems}`로 돌려준다.

| 코드 | 뜻 |
|---|---|
| `manifest_missing` | `manifest.json`이 없거나 읽을 수 없음 |
| `manifest_invalid` | JSON 아님, 필수 필드·타입·64자 hash·중복 경로 위반 |
| `path_unsafe` | 절대 경로, `..`, 빈 구간, 역슬래시, 드라이브 문자 |
| `file_missing` | manifest에 있는 파일이 없거나 일반 파일이 아님 |
| `size_mismatch` | 기록한 크기와 실제 크기가 다름 |
| `hash_mismatch` | 기록한 sha256과 실제 바이트가 다름 |
| `extra_file` | manifest에 없는 파일이 묶음 안에 있음 |
| `row_count_mismatch` | `rows/`의 표별 행 수와 `table_counts`가 다르거나 rows 파일이 깨짐 |

`import_bundle`은 검증을 먼저 한다. 문제가 하나라도 있으면 `BackupError("bundle_invalid")`에 `.problems`를 담고, 행·파일·epoch 어느 것도 쓰지 않는다.

## 5. 가져오기 순서와 epoch

1. 묶음 전체 검증(위 4절).
2. 같은 `project_id`가 있으면 `project_exists`, 같은 slug 등 유일 키가 겹치면 `project_conflict`.
3. 대상 객체 경로에 같은 바이트가 있으면 건너뛰고, 다른 바이트가 있으면 `object_conflict`. 이 검사는 하나도 쓰기 전에 끝낸다.
4. 새 객체 파일을 `wx`(덮어쓰지 않음)로 복사한다.
5. 행 삽입과 epoch 갱신을 **하나의 `tx()`**로 한다. 표 사이 순환 FK 때문에 `PRAGMA defer_foreign_keys = ON`으로 COMMIT까지 검사를 미룬다(트랜잭션과 함께 자동 해제).
6. 실패하면 tx는 롤백되고, 4단계에서 만든 파일만 지운다.

성공하면 대상 `db_meta.cursor_epoch`은 `max(대상 epoch, manifest.cursor_epoch) + 1`이 된다. `database_instance_id`는 바꾸지 않는다. `assert_cursor_epoch`은 10진 문자열·bigint만 받고, 현재 epoch와 다르면 `cursor_epoch_stale`, 10진수가 아니면 `cursor_epoch_invalid`다.

## 6. PR9·12에 남긴 것

- blob `state`(staging/ready/quarantined)·고아·격리 정리 규칙(PR9). PR3는 행과 바이트를 그대로 옮긴다.
- 복원 뒤 전체 검증(개수·본문·ID·연결·보고서 재생성)과 쓰기 전/후 되돌리기(PR12).
- 백업 위치가 PES 홈·OneDrive 안이면 거부하는 검사(PR12/22).
- D1·원격 저장소·대용량 스트리밍 묶음. PR3는 로컬 파일 시스템만 다룬다.
