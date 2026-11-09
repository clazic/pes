/**
 * 등록된 명령 이름의 기대 목록 (정렬된 명시 배열).
 * 뒤 PR(PR7 content.* 등)이 명령을 더하면 이 배열에 이름만 더하고 정렬을 유지한다.
 * COMMANDS 자신에서 기대값을 뽑지 않는다(그러면 시험이 약해진다).
 */
export const EXPECTED_COMMAND_NAMES: readonly string[] = [
  "project.bootstrap",
  "project.set_topic",
  "run.claim",
  "run.complete",
  "run.handoff",
  "run.heartbeat",
  "run.interrupt",
  "run.record_receipt",
  "run.release",
  "run.wait",
];
