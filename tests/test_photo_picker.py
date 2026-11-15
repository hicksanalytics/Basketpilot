from pathlib import Path
from html.parser import HTMLParser

html = (Path(__file__).resolve().parents[1] / 'public' / 'receipts.html').read_text(encoding='utf-8')

class InputInspector(HTMLParser):
    def __init__(self):
        super().__init__(); self.inputs={}
    def handle_starttag(self, tag, attrs):
        if tag=='input':
            item=dict(attrs)
            if 'id' in item: self.inputs[item['id']]=item

p=InputInspector(); p.feed(html)
assert p.inputs['receipt-file']['type']=='file'
assert p.inputs['receipt-file']['accept']=='image/*'
assert 'capture' not in p.inputs['receipt-file'], 'Library selector must not force camera'
assert p.inputs['receipt-camera']['capture']=='environment', 'Camera selector must request the camera'
assert 'Choose from Photos' in html
assert 'Take a new photo' in html
assert "$('receipt-file').addEventListener('change',receiveReceiptPhoto)" in html
assert "$('receipt-camera').addEventListener('change',receiveReceiptPhoto)" in html
assert 'preview.onerror=null' in html
assert not any(x in html for x in ('SCAVIO_API_KEY','sb_secret_', 'vfctfvbufuvmbxnrfmaj'))
print('PASS: separate library and camera pickers, no secret values')
