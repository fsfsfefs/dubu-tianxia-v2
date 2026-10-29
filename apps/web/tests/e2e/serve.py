"""Disposable browser-test API. Never uses the user's .data or credentials."""
import os
import sys
from pathlib import Path
from io import BytesIO

root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / 'apps/api'))
from reader_next_api.application import create_app
from reader_next_api.repository import Repository
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from PIL import Image, ImageDraw, ImageFont
import uvicorn

scratch = Path(os.environ['READER_E2E_DATA']).resolve()
assert scratch.is_relative_to((root / '.tmp').resolve()), 'Browser tests require a disposable .tmp data directory'
repo = Repository(scratch)
writer = PdfWriter()
for text in ['NATIVE READER SEARCH TEST', 'SECOND PAGE SEARCH TARGET']:
    page = writer.add_blank_page(width=595,height=842)
    font = DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    stream = DecodedStreamObject();stream.set_data(f'BT /F1 20 Tf 60 700 Td ({text}) Tj ET'.encode())
    page[NameObject('/Contents')] = writer._add_object(stream)
output=BytesIO();writer.write(output)
repo.add_document('E2E Native.pdf', output.getvalue())
image=Image.new('RGB',(1240,1754),'white');draw=ImageDraw.Draw(image)
font_path=next((path for path in [Path('C:/Windows/Fonts/arial.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if path.exists()),None)
assert font_path, 'A scalable test font is required'
font=ImageFont.truetype(str(font_path),52)
draw.text((80,260),'SCANNED READER OCR TEST',font=font,fill='black')
draw.text((80,380),'SEARCHABLE SCANNED PAGE',font=font,fill='black')
output=BytesIO();image.save(output,format='PDF',resolution=150)
repo.add_document('E2E Scan.pdf',output.getvalue())
uvicorn.run(create_app(scratch),host='127.0.0.1',port=8791,log_level='warning')
