"""질문 화면: ask-*.html 에 들어가는 질문 데이터·이스케이프·공용 질문 모듈을 고정한다.

브라우저 자동화 없이 생성된 HTML 과 그 안의 JSON 만 검사한다.
"""
import html as htmlmod
import json
from pathlib import Path

import pytest

from conftest import ROOT

DATA_OPEN = '<script id="data" type="application/json">'


def _public(value):
    """cmd_ask 의 strip_private 과 같은 규칙: 밑줄로 시작하는 키는 렌더하지 않는다."""
    if isinstance(value, dict):
        return {key: _public(item) for key, item in value.items() if not key.startswith("_")}
    if isinstance(value, list):
        return [_public(item) for item in value]
    return value


def _data(html):
    start = html.index(DATA_OPEN) + len(DATA_OPEN)
    end = html.index("</script>", start)
    return html[start:end], json.loads(html[start:end])


def _ask(cli, project, spec, tmp_path, name="spec.json"):
    spec_path = Path(tmp_path) / name
    spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    code, out, err = cli("ask", project, spec_path)
    assert code == 0, (out, err)
    return Path(out.strip())


def test_ask_embeds_question_data_and_escapes_html(cli, synthetic_project, tmp_path):
    title = '합성 <질문> & "제목" \'따옴표\''
    spec = {
        "id": "sel-13-ask",
        "stage": "plan",
        "kind": "stage_start",
        "stage_label": "기획",
        "round": 2,
        "title": title,
        "intro": "합성 소개",
        "inherited": [{"label": "발주처", "value": "합성 기관"}],
        "questions": [
            {"id": "q1", "label": "필수 <b>질문</b>", "type": "single", "required": True,
             "other": True,
             "options": [
                 {"value": "a", "label": "A </script><script>alert(1)</script>",
                  "recommended": True},
                 {"value": "b", "label": "B"}]},
            {"id": "q2", "label": "조건부", "type": "text",
             "show_if": {"id": "q1", "in": ["a"]}, "other": "직접 적기"},
            {"id": "q3", "label": "글쓰기", "type": "textarea"},
            {"id": "q4", "label": "여러 개", "type": "multi", "required": True,
             "options": [{"value": "x", "label": "X"}, {"value": "y", "label": "Y"}]},
            {"id": "q5", "label": "비공개 조건", "type": "text",
             "_when": {"id": "q1", "in": ["b"]}},
        ],
        "_note": "렌더하지 않는 내부 메모",
    }
    project = synthetic_project("legacy")
    rendered = _ask(cli, project, spec, tmp_path)
    assert rendered == project / "ask-sel-13-ask.html"
    html = rendered.read_text(encoding="utf-8")

    blob, data = _data(html)
    assert data["spec"] == _public(spec)
    assert "_note" not in data["spec"]
    assert "_when" not in data["spec"]["questions"][4]
    assert data["topic"] == "합성 주제"
    assert [stage["key"] for stage in data["stages"]] == [
        "plan", "research", "analyze", "write", "verify", "publish"]
    assert data["stages"][0]["status"] == "asking"

    # 데이터 속의 </script> 는 이스케이프되어 데이터 스크립트를 조기 종료하지 않는다.
    assert "</script>" not in blob
    assert "<\\/" in blob
    assert data["spec"]["questions"][0]["options"][0]["label"] == \
        "A </script><script>alert(1)</script>"

    # 제목은 HTML 로 이스케이프되고 원문 그대로 들어가지 않는다.
    assert f"<title>{htmlmod.escape(title)}</title>" in html
    assert f"<title>{title}</title>" not in html
    assert "/*__DATA__*/null" not in html
    assert "<!--__QUESTIONS__-->" not in html


def test_ask_preserves_real_question_bank_definitions(cli, synthetic_project):
    project = synthetic_project("legacy")
    bank = ROOT / "questions" / "plan.json"
    source = json.loads(bank.read_text(encoding="utf-8"))
    code, out, err = cli("ask", project, bank)
    assert code == 0, (out, err)
    rendered = Path(out.strip())
    assert rendered == project / "ask-plan-start.html"
    html = rendered.read_text(encoding="utf-8")
    _, data = _data(html)

    assert data["spec"] == _public(source)
    questions = {q["id"]: q for q in data["spec"]["questions"]}
    assert questions["topic"]["required"] is True
    assert questions["purpose"]["other"] is True
    assert questions["research_type"]["show_if"] == {"id": "format", "in": ["hwpx"]}
    assert questions["policy"]["show_if"] == {"id": "purpose", "in": ["report", "decision"]}
    assert questions["stage_reports"]["type"] == "multi"


def test_question_module_keeps_other_required_and_conditional_ui(cli, synthetic_project):
    project = synthetic_project("legacy")
    code, out, err = cli("ask", project, ROOT / "questions" / "plan.json")
    assert code == 0, (out, err)
    html = Path(out.strip()).read_text(encoding="utf-8")
    module = (ROOT / "templates" / "_questions.html").read_text(encoding="utf-8")

    # 공용 질문 모듈이 한 번 끼워져 있다.
    assert html.count(module) == 1

    # 모든 질문에 '기타 · 덧붙일 말' 칸을 붙이고, 답에는 <id>__other 로 저장한다.
    assert 'data-qo=' in module
    assert "q.id + '__other'" in module
    assert "typeof q.other === 'string'" in module

    # 필수 표시(*), 조건부 표시(show_if), 숨김 처리가 남아 있다.
    assert "class=\"req\">*" in module
    assert "q.show_if" in module
    assert "classList.toggle('hidden'" in module

    # 질문별 정의는 데이터 JSON 에 그대로 남아 있다(렌더는 그 정의를 읽는다).
    _, data = _data(html)
    by_id = {q["id"]: q for q in data["spec"]["questions"]}
    assert by_id["topic"]["required"] is True
    assert by_id["purpose"]["other"] is True
    assert by_id["research_type"]["show_if"]["id"] == "format"
    assert by_id["policy"]["show_if"]["in"] == ["report", "decision"]


def test_ask_id_sanitizes_output_name(cli, synthetic_project, tmp_path):
    project = synthetic_project("legacy")
    spec = {"id": "My Ask / 1", "stage": "plan", "kind": "stage_start",
            "title": "합성", "questions": []}
    rendered = _ask(cli, project, spec, tmp_path)
    assert rendered.name == "ask-my-ask---1.html"
    assert rendered.parent == project
