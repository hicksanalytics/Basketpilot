from pathlib import Path
root=Path(__file__).resolve().parents[1]
html=(root/'public'/'index.html').read_text(encoding='utf-8')
yaml=(root/'render.yaml').read_text(encoding='utf-8')
assert '<title>BasketPilot' in html
assert 'FICTIONAL PRICES ONLY' in html
assert 'fictional' in html.lower()
assert 'id="basket"' in html and 'id="compare"' in html
assert 'staticPublishPath: ./public' in yaml
assert 'runtime: static' in yaml
assert 'plan:' not in yaml
assert not any(s in html for s in ('SCAVIO_API_KEY','service_role','sb_secret_','Bearer ', 'vfctfvbufuvmbxnrfmaj', '15183722867', '13627565539'))
assert not list(root.rglob('*.sqlite3'))
assert not list(root.rglob('*.csv'))
print('PASS: synthetic preview, free-only static blueprint, no private source data')
