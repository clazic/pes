"""Characterization tests for CLI state transitions and generated reports.

The tests drive the real CLI through subprocesses.  They only use synthetic
projects created under pytest's temporary directories.
"""
import json
from pathlib import Path
import shutil

import pytest

STAGES = ("plan", "research", "analyze", "write", "verify", "publish")


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def _project_json(project):
    return json.loads((project / "project.json").read_text(encoding="utf-8"))


def _edit_project(project, mutate):
    data = _project_json(project)
    mutate(data)
    _write_json(project / "project.json", data)
    return data


def _init(cli, tmp_path, name="합성 프로젝트", topic="합성 주제", source=None):
    project = tmp_path / name
    args = ["init", project, "--topic", topic]
    if source is not None:
        args += ["--import", source]
    code, out, err = cli(*args)
    assert code == 0, (out, err)
    return project


def _merge(cli, tmp_path, project, stage, results, name="result"):
    folder = tmp_path / "results" / name
    files = []
    for index, result in enumerate(results):
        files.append(_write_json(folder / "{}.json".format(index), result))
    code, out, err = cli("merge", project, stage, *files)
    assert code == 0, (out, err)
    return out


def _approve(cli, project, stage):
    code, out, err = cli("approve", project, stage)
    assert code == 0, (out, err)
    return out


def _make_library(tmp_path):
    source = tmp_path / "research-loop"
    _write_json(source / "state.json", {
        "round": 3,
        "topic": "기존 조사",
        "settings": {},
        "items": [
            {"id": 5, "title": "기존 조사 항목", "summary": "기존 요약",
             "details": "기존 상세", "confidence": "high", "status": "done",
             "sources": [{"url": "https://library.test/5", "title": "기존 출처", "method": "browser"}],
             "stats": [{"name": "기존 지표", "value": 5, "unit": "개"}],
             "shots": ["shot.png"], "conflicts": ["기존 충돌"]},
            {"id": 6, "title": "삭제된 항목", "status": "removed"},
        ],
        "suggestions": [],
        "warnings": [],
    })
    return source


# ---------- 라운드 ----------

def test_round_start_increments_and_clears_changes(cli, tmp_path):
    project = _init(cli, tmp_path)

    code, out, err = cli("round-start", project, "plan")
    assert code == 0, (out, err)
    assert "R1 시작" in out
    data = _project_json(project)
    plan = data["stages"]["plan"]
    assert plan["round"] == 1
    assert plan["status"] == "active"
    assert plan["changes"] == []
    assert data["current"] == "plan"

    def add_change(p):
        p["stages"]["plan"]["changes"] = ["조사: 합성 변경"]

    _edit_project(project, add_change)
    code, out, err = cli("round-start", project, "plan")
    assert code == 0, (out, err)
    plan = _project_json(project)["stages"]["plan"]
    assert plan["round"] == 2
    assert plan["changes"] == []
    assert len(plan["history"]) == 1
    assert "R1" in plan["history"][0]
    assert "조사" in plan["history"][0]  # changes 의 ':' 앞부분만 이력에 남는다
    assert "snapshots/plan-R1.json" in plan["history"][0]


# ---------- 병합 ----------

def test_merge_creates_item_dedupes_sources_and_collects_links(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "research")
    _merge(cli, tmp_path, project, "research", [{
        "id": 1, "title": "조사 항목", "summary": "첫 요약", "details": "첫 상세",
        "sources": [
            {"url": "https://example.test/a", "title": "출처 A", "method": "browser"},
            {"url": "https://example.test/a", "title": "중복 A", "method": "browser"},
            {"url": "https://example.test/b", "title": "출처 B"},
        ],
        "stats": [{"label": "합성 지표", "value": 7, "unit": "건"}],
        "links": {"plan": [1, 2]},
        "open_questions": ["추가 확인 필요"],
    }], name="first")

    item = _project_json(project)["stages"]["research"]["items"][0]
    assert [s["url"] for s in item["sources"]] == ["https://example.test/a", "https://example.test/b"]
    assert item["sources"][0]["title"] == "출처 A"
    assert item["stats"] == [{"label": "합성 지표", "value": 7, "unit": "건", "name": "합성 지표"}]
    assert item["links"]["plan"] == [1, 2]
    assert item["status"] == "done"
    assert item["depth"] == 1
    assert item["updated_round"] == 1
    suggestions = _project_json(project)["stages"]["research"]["suggestions"]
    assert "[#1] 추가 확인 필요" in suggestions

    _merge(cli, tmp_path, project, "research", [{
        "id": 1, "title": "조사 항목", "summary": "둘째 요약",
        "sources": [
            {"url": "https://example.test/a", "title": "다시 A"},
            {"url": "https://example.test/c", "title": "출처 C"},
        ],
        "links": {"plan": [2, 3], "research": [9]},
    }], name="second")
    research = _project_json(project)["stages"]["research"]
    item = research["items"][0]
    assert len(research["items"]) == 1
    assert item["summary"] == "둘째 요약"
    assert [s["url"] for s in item["sources"]] == [
        "https://example.test/a", "https://example.test/b", "https://example.test/c"]
    assert item["sources"][0]["title"] == "출처 A"
    assert item["links"]["plan"] == [1, 2, 3]
    assert item["links"]["research"] == [9]


def test_merge_assigns_item_id_when_result_has_none(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "research")
    _merge(cli, tmp_path, project, "research", [{"id": 4, "title": "먼저 온 항목"}], name="first")
    _merge(cli, tmp_path, project, "research", [{"title": "번호 없는 항목"}], name="second")
    items = _project_json(project)["stages"]["research"]["items"]
    assert [item["id"] for item in items] == [4, 5]
    assert items[1]["title"] == "번호 없는 항목"


def test_merge_keeps_plan_reuse_field(cli, tmp_path):
    # PR17(SEL-50): 스킬이 project.json 을 직접 고치지 않고 merge 로 넘기므로, merge 가 reuse 를 보존해야
    # approve plan 의 library 재사용이 산다(1차 리뷰 필수 2, leader 결정). 예전에는 버리는 동작을 고정했었다.
    project = _init(cli, tmp_path)
    _merge(cli, tmp_path, project, "plan", [
        {"id": 1, "title": "주제", "kind": "topic", "reuse": 5},
    ], name="reuse")
    item = _project_json(project)["stages"]["plan"]["items"][0]
    assert item.get("reuse") == 5


def test_merge_write_section_preserves_source_order(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "write")
    _merge(cli, tmp_path, project, "write", [{
        "id": 3, "kind": "section", "title": "첫 절",
        "details": "본문.[^1] 둘째.[^2]",
        "sources": [
            {"url": "https://example.test/b", "title": "B"},
            {"url": "https://example.test/a", "title": "A"},
            {"url": "https://example.test/b", "title": "B again"},
        ],
    }], name="first")
    item = _project_json(project)["stages"]["write"]["items"][0]
    assert [s["url"] for s in item["sources"]] == [
        "https://example.test/b", "https://example.test/a", "https://example.test/b"]

    _merge(cli, tmp_path, project, "write", [{
        "id": 3, "kind": "section", "title": "첫 절",
        "sources": [
            {"url": "https://example.test/c", "title": "C"},
            {"url": "https://example.test/a", "title": "A"},
        ],
    }], name="second")
    item = _project_json(project)["stages"]["write"]["items"][0]
    assert [s["url"] for s in item["sources"]] == [
        "https://example.test/c", "https://example.test/a"]


# ---------- 승인 ----------

def test_approve_plan_creates_and_reuses_research_items(cli, tmp_path):
    library = _make_library(tmp_path)
    project = _init(cli, tmp_path, source=library)
    _merge(cli, tmp_path, project, "plan", [
        {"id": 1, "title": "재사용 주제", "kind": "topic", "question": "재사용 질문", "reuse": 5},
        {"id": 2, "title": "새 주제", "kind": "topic", "question": "새 질문"},
        {"id": 3, "title": "제외 주제", "kind": "topic", "status": "removed"},
        {"id": 4, "title": "쟁점", "kind": "issue"},
    ], name="topics")

    # plan 스킬은 라이브러리 id 를 topic.reuse 에 직접 적는다. merge 는 이 필드를 옮기지 않는다.
    def set_reuse(p):
        p["stages"]["plan"]["items"][0]["reuse"] = 5

    _edit_project(project, set_reuse)

    out = _approve(cli, project, "plan")
    assert "조사 항목 2개 생성 (기존 조사 재사용 1개)" in out
    data = _project_json(project)
    assert data["stages"]["plan"]["status"] == "approved"
    assert data["stages"]["plan"]["approved_at"]
    assert data["stages"]["plan"]["stale"] is False
    assert data["stages"]["research"]["status"] == "asking"
    assert data["current"] == "research"
    research = data["stages"]["research"]["items"]
    assert [item["title"] for item in research] == ["재사용 주제", "새 주제"]
    by_title = {item["title"]: item for item in research}
    assert by_title["재사용 주제"]["links"]["plan"] == [1]
    assert by_title["새 주제"]["links"]["plan"] == [2]
    reused = by_title["재사용 주제"]
    assert reused["status"] == "deepen"
    assert reused["links"]["library"] == [5]
    assert reused["summary"] == "기존 요약"
    assert reused["sources"][0]["url"] == "https://library.test/5"
    assert "기존 조사(라이브러리 #5) 재사용" in reused["request"]

    _approve(cli, project, "plan")
    research_again = _project_json(project)["stages"]["research"]["items"]
    assert [item["title"] for item in research_again] == ["재사용 주제", "새 주제"]


def test_approve_moves_to_next_stage_asking(cli, tmp_path):
    project = _init(cli, tmp_path)
    _approve(cli, project, "plan")
    _approve(cli, project, "research")
    data = _project_json(project)
    assert data["current"] == "analyze"
    assert data["stages"]["research"]["status"] == "approved"
    assert data["stages"]["analyze"]["status"] == "asking"
    assert data["stages"]["write"]["status"] == "pending"


def test_approve_final_stage_marks_project_complete(cli, tmp_path):
    project = _init(cli, tmp_path)
    for stage in STAGES:
        _approve(cli, project, stage)
    data = _project_json(project)
    assert data["complete"] is True
    assert data["current"] == "publish"
    assert all(data["stages"][stage]["status"] == "approved" for stage in STAGES)
    code, out, err = cli("status", project)
    assert code == 0, (out, err)
    assert "전체 완료" in out


# ---------- 다시 열기 ----------

def test_reopen_marks_later_stages_stale(cli, tmp_path):
    project = _init(cli, tmp_path)
    _approve(cli, project, "plan")
    _approve(cli, project, "research")
    _approve(cli, project, "analyze")

    def add_review_state(p):
        research = p["stages"]["research"]
        research["review"] = {"round": 1, "questions": [{"id": "합성-점검"}]}
        research["stale"] = True

    _edit_project(project, add_review_state)
    before = _project_json(project)["stages"]["research"]
    assert before["review"] is not None
    assert before["stale"] is True

    code, out, err = cli("reopen", project, "research")
    assert code == 0, (out, err)
    assert "조사 다시 열림" in out
    data = _project_json(project)
    assert data["current"] == "research"
    research = data["stages"]["research"]
    assert research["status"] == "active"
    assert research["stale"] is False
    assert research["approved_at"] is None
    assert research["review"] is None
    assert data["stages"]["analyze"]["stale"] is True
    assert data["stages"]["write"]["stale"] is True
    assert data["stages"]["verify"]["stale"] is False
    assert data["stages"]["publish"]["stale"] is False


def test_reopen_complete_project_clears_complete(cli, tmp_path):
    project = _init(cli, tmp_path)
    for stage in STAGES:
        _approve(cli, project, stage)
    assert _project_json(project)["complete"] is True

    code, out, err = cli("reopen", project, "plan")
    assert code == 0, (out, err)
    data = _project_json(project)
    assert data["current"] == "plan"
    assert data["stages"]["plan"]["status"] == "active"
    assert data["stages"]["research"]["stale"] is True
    assert data["complete"] is False


# ---------- 결함 후보 (현재 동작 재현) ----------

@pytest.mark.xfail(strict=True, reason="SEL-12 결함 후보 ②: 같은 병합을 다시 보내면 depth 가 또 오른다")
def test_resubmitting_same_merge_does_not_raise_depth(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "research")
    result = {"id": 1, "title": "같은 결과", "summary": "같은 요약",
              "sources": [{"url": "https://example.test/same", "title": "같은 출처"}]}
    _merge(cli, tmp_path, project, "research", [result], name="same-1")
    _merge(cli, tmp_path, project, "research", [result], name="same-2")
    item = _project_json(project)["stages"]["research"]["items"][0]
    assert item["depth"] == 1


def test_render_same_round_does_not_overwrite_snapshot(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "plan")
    _merge(cli, tmp_path, project, "plan", [{"id": 1, "title": "항목", "summary": "초기 요약"}],
           name="initial")
    code, out, err = cli("render", project, "plan")
    assert code == 0, (out, err)
    snapshot = project / "snapshots" / "plan-R1.json"
    first = snapshot.read_bytes()
    assert b"\xec\xb4\x88\xea\xb8\xb0" in first  # 초기 (UTF-8)

    _merge(cli, tmp_path, project, "plan", [{"id": 1, "title": "항목", "summary": "바뀐 요약"}],
           name="changed")
    code, out, err = cli("render", project, "plan")
    assert code == 0, (out, err)
    assert snapshot.read_bytes() == first


def test_render_same_round_keeps_later_states_in_version_folder(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "plan")
    _merge(cli, tmp_path, project, "plan", [{"id": 1, "title": "항목", "summary": "처음 요약"}],
           name="version-initial")
    code, out, err = cli("render", project, "plan")
    assert code == 0, (out, err)

    _merge(cli, tmp_path, project, "plan", [{"id": 1, "title": "항목", "summary": "중간 요약"}],
           name="version-middle")
    code, out, err = cli("render", project, "plan")
    assert code == 0, (out, err)

    base = project / "snapshots" / "plan-R1.json"
    assert "처음 요약" in base.read_text(encoding="utf-8")
    versions = sorted((project / "snapshots" / "plan-R1").glob("*.json"))
    assert versions, "같은 라운드의 바뀐 상태가 하위 폴더 스냅샷에 남아야 한다"
    states = [json.loads(path.read_text(encoding="utf-8"))["state"] for path in versions]
    assert any(state["items"][0]["summary"] == "중간 요약" for state in states)

    # 다음 라운드로 넘어가도 중간 상태가 하위 폴더에 그대로 남는다.
    cli("round-start", project, "plan")
    _merge(cli, tmp_path, project, "plan", [{"id": 1, "title": "항목", "summary": "마지막 요약"}],
           name="version-last")
    code, out, err = cli("render", project, "plan")
    assert code == 0, (out, err)
    states = [json.loads(path.read_text(encoding="utf-8"))["state"]
              for path in sorted((project / "snapshots" / "plan-R1").glob("*.json"))]
    assert any(state["items"][0]["summary"] == "중간 요약" for state in states)


# ---------- 보고서 ----------

def test_stage_report_generates_markdown_html_and_registers_files(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "plan")
    _merge(cli, tmp_path, project, "plan", [
        {"id": 1, "kind": "rq", "title": "연구 질문", "summary": "질문 요약",
         "sources": [
             {"url": "https://example.test/b", "title": "출처 B"},
             {"url": "https://example.test/a", "title": "출처 A"},
             {"url": "https://example.test/b", "title": "출처 B 중복"},
         ]},
        {"id": 2, "kind": "topic", "title": "조사 범위", "summary": "범위 요약",
         "sources": [{"url": "https://example.test/c", "title": "출처 C"}]},
    ], name="plan-items")

    code, out, err = cli("report", project, "plan")
    assert code == 0, (out, err)
    report_dir = project / "reports" / "plan"
    md = (report_dir / "report.md").read_text(encoding="utf-8")
    assert md.startswith("# 합성 주제 — 기획보고서\n")
    assert "- 단계: 기획 · 라운드 1회" in md
    assert "- 항목 2개 · 출처 3개 (원문 확인 0개)" in md
    assert md.index("#### #1 연구 질문") < md.index("#### #2 조사 범위")
    assert md.index("1. 출처 B — https://example.test/b") < md.index("2. 출처 A — https://example.test/a")
    assert md.index("2. 출처 A — https://example.test/a") < md.index("3. 출처 C — https://example.test/c")
    assert "출처 B 중복" not in md

    html = (report_dir / "report.html").read_text(encoding="utf-8")
    assert "합성 주제" in html
    assert "기획보고서" in html

    data = _project_json(project)["stages"]["plan"]
    assert data["reports_built"]
    formats = {entry["format"]: entry for entry in data["reports"]}
    assert Path(formats["md"]["path"]) == Path("reports") / "plan" / "report.md"
    assert Path(formats["html"]["path"]) == Path("reports") / "plan" / "report.html"


def test_assemble_orders_sections_and_numbers_footnotes(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "write")
    _merge(cli, tmp_path, project, "write", [
        {"id": 10, "order": 2, "kind": "section", "title": "둘째 장",
         "details": "둘째 본문.[^1] 셋째 출처.[^2]",
         "sources": [
             {"url": "https://example.test/a", "title": "출처 A", "method": "browser"},
             {"url": "https://example.test/c", "title": "출처 C"},
         ]},
        {"id": 20, "order": 1, "kind": "section", "title": "첫째 장",
         "details": "첫째 본문.[^1] 둘째 출처.[^2]",
         "sources": [
             {"url": "https://example.test/a", "title": "출처 A", "method": "browser"},
             {"url": "https://example.test/b", "title": "출처 B"},
         ]},
    ], name="sections")

    def add_summaries(p):
        p["executive_summary"] = "합성 요약"
        p["conclusion"] = "합성 결론"

    _edit_project(project, add_summaries)
    code, out, err = cli("assemble", project)
    assert code == 0, (out, err)
    md = (project / "out" / "report.md").read_text(encoding="utf-8")
    assert md.index("# 합성 주제") < md.index("## 요약")
    assert md.index("## 요약") < md.index("첫째 본문.")
    assert md.index("첫째 본문.") < md.index("둘째 본문.")
    assert md.index("둘째 본문.") < md.index("## 결론")
    assert md.index("## 결론") < md.index("[^1]: 출처 A")
    assert "첫째 본문.[^1] 둘째 출처.[^2]" in md
    assert "둘째 본문.[^1] 셋째 출처.[^3]" in md
    assert "[^1]: 출처 A, https://example.test/a" in md
    assert "[^2]: 출처 B, https://example.test/b" in md
    assert "[^3]: 출처 C, https://example.test/c" in md

    sources = json.loads((project / "out" / "sources.json").read_text(encoding="utf-8"))
    assert [(s["n"], s["title"], s["url"]) for s in sources] == [
        (1, "출처 A", "https://example.test/a"),
        (2, "출처 B", "https://example.test/b"),
        (3, "출처 C", "https://example.test/c"),
    ]
    assert [s["verified"] for s in sources] == [True, False, False]


def test_web_report_builds_from_markdown_and_sources(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "write")
    _merge(cli, tmp_path, project, "write", [{
        "id": 1, "kind": "section", "title": "장",
        "details": "웹 본문.[^1]",
        "sources": [{"url": "https://example.test/web", "title": "웹 출처"}],
    }], name="web-section")

    code, out, err = cli("web", project, "--assemble")
    assert code == 0, (out, err)
    html_path = project / "out" / "report.html"
    assert (project / "out" / "report.md").exists()
    assert html_path.exists()
    html = html_path.read_text(encoding="utf-8")
    assert "합성 주제" in html
    assert "웹 본문." in html
    assert "https://example.test/web" in html
    assert "출처 1개" in out


# ---------- 복원 ----------

def test_restore_copy_reloads_and_regenerates_outputs(cli, tmp_path):
    project = _init(cli, tmp_path)
    cli("round-start", project, "plan")
    _merge(cli, tmp_path, project, "plan", [{
        "id": 1, "kind": "rq", "title": "복원 질문", "summary": "복원 요약",
        "sources": [{"url": "https://example.test/restore", "title": "복원 출처"}],
    }], name="restore-plan")
    cli("round-start", project, "write")
    _merge(cli, tmp_path, project, "write", [{
        "id": 1, "kind": "section", "title": "복원 장",
        "details": "복원 본문.[^1]",
        "sources": [{"url": "https://example.test/restore", "title": "복원 출처"}],
    }], name="restore-write")

    restored = tmp_path / "복원 위치" / "사본 프로젝트"
    shutil.copytree(project, restored)
    shutil.rmtree(project)
    assert not project.exists()
    assert (restored / "project.json").exists()

    code, out, err = cli("status", restored)
    assert code == 0, (out, err)
    assert "합성 주제" in out
    assert "현재 단계: 집필" in out

    code, out, err = cli("render", restored)
    assert code == 0, (out, err)
    assert (restored / "index.html").exists()
    assert "합성 주제" in (restored / "index.html").read_text(encoding="utf-8")

    code, out, err = cli("report", restored, "plan")
    assert code == 0, (out, err)
    assert "복원 요약" in (restored / "reports" / "plan" / "report.md").read_text(encoding="utf-8")

    code, out, err = cli("assemble", restored)
    assert code == 0, (out, err)
    assert "복원 본문." in (restored / "out" / "report.md").read_text(encoding="utf-8")

    code, out, err = cli("web", restored)
    assert code == 0, (out, err)
    assert (restored / "out" / "report.html").exists()


# ---------- 깨진·큰 project.json ----------

def test_cli_broken_project_json_keeps_current_error_behavior(cli, synthetic_project):
    project = synthetic_project("broken")
    before = (project / "project.json").read_bytes()
    code, out, err = cli("status", project)
    assert code == 1
    assert out == ""
    assert "JSONDecodeError" in err
    assert (project / "project.json").read_bytes() == before


def test_cli_large_project_json_reads_and_updates(cli, synthetic_project):
    project = synthetic_project("large")
    # 현재 fixture 에는 최상위 "current" 가 없어서 status 는 KeyError 로 끝난다.
    code, out, err = cli("status", project)
    assert code == 1
    assert "합성 주제" in out
    assert "KeyError" in err and "'current'" in err

    # round-start 는 load 후 current 를 직접 채우므로 큰 파일도 읽고 저장한다.
    code, out, err = cli("round-start", project, "plan")
    assert code == 0, (out, err)
    data = _project_json(project)
    assert data["synthetic_payload"] == "x" * (2 * 1024 * 1024)
    assert data["stages"]["plan"]["round"] == 1
    assert data["current"] == "plan"

    code, out, err = cli("status", project)
    assert code == 0, (out, err)
    assert "현재 단계: 기획" in out
