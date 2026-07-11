import base64
import io
import json
import os
from http.server import BaseHTTPRequestHandler

import openai
from PIL import Image


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

        boundary = content_type.split('boundary=')[1].strip()
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
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
                This is an image of a purchase receipt.
                Extract the line item data and the grand total.

                Return raw JSON only, no markdown formatting or code blocks:
                {
                    "total": "60500.00",
                    "items": [{"name": "Noodle", "amount": "30000.00"}, {"name": "Coffee", "amount": "25000.00"}]
                }

                Preserve the order of items as shown in the receipt.
                If there are 3 digits after a dot, it's a thousands separator.
                If any info is ambiguous or not clear, use null.
                Do not guess or hallucinate.
            '''
            client = openai.OpenAI(api_key=openai_api_key)
            response = client.chat.completions.create(
                model='gpt-4o',
                messages=[
                    {
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': prompt},
                            {'type': 'image_url', 'image_url': {'url': data_url}},
                        ],
                    }
                ],
                max_tokens=1024,
            )

            content = response.choices[0].message.content.strip()
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
