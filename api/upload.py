import base64
import io
import json
import os
from http.server import BaseHTTPRequestHandler

import openai
from PIL import Image


MAX_REQUEST_BYTES = 10 * 1024 * 1024
RECEIPT_MODEL = 'gpt-6-luna'


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        openai_api_key = os.environ.get('OPENAI_API_KEY')
        if not openai_api_key:
            self.send_error(500, 'Configuration error')
            return

        content_type = self.headers.get('Content-Type', '')
        if 'boundary=' not in content_type:
            self.send_error(400, 'Missing header')
            return

        try:
            content_length = int(self.headers.get('Content-Length', ''))
        except (TypeError, ValueError):
            self.send_error(400, 'Invalid content length')
            return
        if content_length <= 0:
            self.send_error(400, 'Missing request body')
            return
        if content_length > MAX_REQUEST_BYTES:
            self.send_error(413, 'Upload too large')
            return

        boundary = content_type.split('boundary=')[1].strip()
        raw = self.rfile.read(content_length)
        if len(raw) != content_length:
            self.send_error(400, 'Incomplete request body')
            return
        parts = raw.split(f'--{boundary}'.encode())
        image_bytes = None
        for part in parts:
            if b'Content-Disposition' in part and b'name="file"' in part:
                idx = part.find(b'\r\n\r\n')
                if idx == -1:
                    continue
                data = part[idx + 4:]
                data = data.split(b'\r\n--')[0]
                data = data.split(b'\r\n--')[0]
                image_bytes = data.strip(b'\r\n')
        if not image_bytes:
            self.send_error(400, 'Missing file')
            return

        img = Image.open(io.BytesIO(image_bytes))
        max_dim = 1024
        w, h = img.size
        if w > max_dim or h > max_dim:
            ratio = min(max_dim / w, max_dim / h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=80)
        b64 = base64.b64encode(buf.getvalue()).decode()
        data_url = f'data:image/jpeg;base64,{b64}'

        try:
            prompt = '''
                Extract each line item and the grand total from this purchase receipt.

                Rules:
                - "total" = grand total at the bottom of the receipt
                - "amount" = line total for that item (ignore unit prices and quantities)
                - Preserve item order as printed on receipt
                - 3 digits after a dot or comma means thousand separator, not decimal
                - Output numbers as strings without thousand separators (e.g., "60000.00" not "60.000,00")
                - If ambiguous or unclear, use null — never guess or hallucinate
            '''
            client = openai.OpenAI(api_key=openai_api_key)
            response = client.chat.completions.create(
                model=RECEIPT_MODEL,
                messages=[
                    {
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': prompt},
                            {'type': 'image_url', 'image_url': {'url': data_url}},
                        ],
                    }
                ],
                max_completion_tokens=1024,
                response_format={
                    'type': 'json_schema',
                    'json_schema': {
                        'name': 'receipt',
                        'strict': True,
                        'schema': {
                            'type': 'object',
                            'properties': {
                                'total': {'type': ['string', 'null']},
                                'items': {
                                    'type': 'array',
                                    'items': {
                                        'type': 'object',
                                        'properties': {
                                            'name': {'type': ['string', 'null']},
                                            'amount': {'type': ['string', 'null']},
                                        },
                                        'required': ['name', 'amount'],
                                        'additionalProperties': False,
                                    },
                                },
                            },
                            'required': ['total', 'items'],
                            'additionalProperties': False,
                        },
                    },
                }
            )

            if not response.choices:
                self.send_error(500, 'Failed to process image')
                return

            choice = response.choices[0]
            content = choice.message.content
            if not isinstance(content, str) or not content.strip():
                self.send_error(500, 'Failed to process image')
                return
            content = content.strip()
            if content.startswith('```'):
                content = content.split('\n', 1)[-1].rsplit('```', 1)[0].strip()
            try:
                items = json.loads(content)
            except json.JSONDecodeError:
                self.send_error(500, 'Failed to parse receipt')
                return

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(items).encode())
        except Exception:
            self.send_error(500, 'Failed to process image')
