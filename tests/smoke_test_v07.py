from pathlib import Path
root=Path(__file__).resolve().parents[1]
index=(root/'public'/'index.html').read_text(encoding='utf-8')
page=(root/'public'/'receipts.html').read_text(encoding='utf-8')
parser=(root/'public'/'receipt-parser.js').read_text(encoding='utf-8')
assert '<title>BasketPilot' in index and 'FICTIONAL PRICES ONLY' in index
assert 'href="/receipts.html"' in index
assert 'id="receipt-file"' in page and 'id="receipt-text"' in page
assert 'Tesseract.createWorker' in page and '7.0.0' in page
assert 'receipt-parser.js' in page and 'parseReceipt' in parser
assert 'Tapping Save stores parsed purchases in your private account' in page
assert 'The original image stays on your phone unless you separately opt in' in page
for source in (page,parser,index):
    for secret in ('SCAVIO_API_KEY', 'service_role', 'sb_secret_', 'vfctfvbufuvmbxnrfmaj', '15183722867', '13627565539'):
        assert secret not in source
assert all(x not in page for x in ('localStorage','fetch(', 'XMLHttpRequest', 'supabase.co', 'supabase-js'))
assert not list(root.rglob('*.sqlite3'))
assert not list(root.rglob('*.csv'))
print('PASS v0.7 static privacy guardrails and receipt page wiring')
