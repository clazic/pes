from pathlib import Path
import difflib
import hashlib

out = Path(__file__).parent
dashboard = """
  /* Card shape: compact document panels */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 12px; grid-auto-rows: 1fr; }
  .kpi { min-width: 0; min-height: 132px; padding: 16px 18px; border-radius: 4px; border-top: 3px solid var(--fg); display: flex; flex-direction: column; }
  .kpi b { font-size: 28px; line-height: 1.25; margin-bottom: 8px; }
  .kpi span { font-size: 13px; }
  .kpi .ksub { font-size: 12px; max-width: none; margin-top: 6px; overflow-wrap: anywhere; }
  section.box { border-radius: 6px; padding: 20px 24px; }
  section.review { border-width: 1px; border-left-width: 4px; }
  section.box.now { border-width: 1px; border-left: 4px solid var(--accent); }
  article.item { border-radius: 6px; margin: 16px 0; }
  .ihead { padding: 14px 20px; background: color-mix(in srgb, var(--chip) 45%, var(--card)); border-bottom: 1px solid var(--line); }
  .ibody { padding-top: 12px; }
  .fb { border-top-style: solid; }
  .gcard { border-radius: 6px; padding: 16px; }
  @media (max-width: 480px) { section.box { padding: 16px; } }
"""
hub = """
/* Card shape: compact document panels */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 12px; grid-auto-rows: 1fr; }
.kpi { width: auto; min-width: 0; min-height: 132px; padding: 16px 18px; border-radius: 4px; border-top: 3px solid var(--fg); display: flex; flex-direction: column; }
.kpi b { font-size: 28px; line-height: 1.25; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
.kpi span { font-size: 13px; }
.grid { border-radius: 6px; }
.head { background: color-mix(in srgb, var(--chip) 45%, var(--card)); }
"""
ask = """
  /* Card shape: compact document panels */
  section.box { border-radius: 6px; padding: 20px 24px; margin: 20px 0; }
  section.box h2 { margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  @media (max-width: 480px) { section.box { padding: 16px; } }
"""
targets = [
    (Path('/Users/clazic/work/pes/templates/dashboard.html'), dashboard),
    (Path('/Users/clazic/work/pes/templates/hub.html'), hub),
    (Path('/Users/clazic/work/pes/templates/ask.html'), ask),
    (Path('/Users/clazic/pes-projects/private-rental-promotion-zones/index.html'), dashboard),
    (Path('/Users/clazic/pes-projects/index.html'), hub),
]
diffs = []
before = {}
for path, css in targets:
    original = path.read_text()
    before[path] = hashlib.sha256(path.read_bytes()).hexdigest()
    assert '</style>' in original, path
    updated = original.replace('</style>', css + '</style>', 1)
    relative = path.relative_to('/')
    diffs.extend(difflib.unified_diff(original.splitlines(True), updated.splitlines(True), fromfile='a/' + str(relative), tofile='b/' + str(relative)))
(out / 'cards.patch').write_text(''.join(diffs))
for path, _ in targets:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before[path]
print(f'Patch generated for {len(targets)} files; original files unchanged.')
