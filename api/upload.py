import base64
import io
import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

import openai
from PIL import Image, ImageOps


MAX_REQUEST_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
ALLOWED_FORMATS = {'JPEG', 'PNG', 'WEBP'}
JPEG_QUALITY = 80
# Long edge sent to the model. Receipt text stays legible at ~1280 px while the
# image costs far fewer vision tokens than the original photo.
MAX_IMAGE_EDGE = 1280
# OCR-style work does not need a flagship model; override with the
# RECEIPT_MODEL environment variable to switch tiers without a redeploy.
RECEIPT_MODEL = os.environ.get('RECEIPT_MODEL', '').strip() or 'gpt-4o-mini'
OPENAI_TIMEOUT_SECONDS = 30
MAX_COMPLETION_TOKENS = 1024


def _origin_allowed(headers):
    host = (os.environ.get('HOST') or '').strip()
    if not host:
        return False
    try:
        expected = urlsplit(host if '://' in host else f'//{host}').hostname
        origin = headers.get('Origin') or headers.get('Referer')
        if not origin:
            return False
        return urlsplit(origin).hostname == expected
    except ValueError:
        return False


def _load_image(image_bytes):
    try:
        with Image.open(io.BytesIO(image_bytes)) as probe:
            if probe.format not in ALLOWED_FORMATS:
                raise ValueError('Unsupported image format')
            if probe.width * probe.height > MAX_IMAGE_PIXELS:
                raise ValueError('Image dimensions too large')
            probe.verify()
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
        return image
    except (Image.DecompressionBombError, Image.UnidentifiedImageError, OSError):
        raise ValueError('Invalid image') from None


def _prepare_data_url(image_bytes):
    img = _load_image(image_bytes)
    # Phone photos carry orientation in EXIF; bake it in so the receipt is upright.
    img = ImageOps.exif_transpose(img)
    w, h = img.size
    scale = MAX_IMAGE_EDGE / max(w, h)
    if scale < 1:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    # Receipts are high-contrast text: grayscale + autocontrast reads better and
    # shrinks the payload without touching legibility.
    if img.mode != 'L':
        img = img.convert('L')
    img = ImageOps.autocontrast(img, cutoff=1)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=JPEG_QUALITY, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f'data:image/jpeg;base64,{b64}'


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        openai_api_key = os.environ.get('OPENAI_API_KEY')
        if not openai_api_key:
            self.send_error(500, 'Configuration error')
            return

        if not _origin_allowed(self.headers):
            self.send_error(403, 'Forbidden')
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

        boundary = content_type.split('boundary=', 1)[1].split(';', 1)[0].strip().strip('"')
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

        try:
            data_url = _prepare_data_url(image_bytes)
        except ValueError as exc:
            self.send_error(400, str(exc))
            return

        try:
            prompt = '''
                Read the receipt in the photo. Focus on the paper receipt; ignore the table, hands,
                shadows, logos, and unrelated background text. The receipt may be rotated, tilted,
                or perspective-distorted; correct for this visually before reading.

                Extract each purchased item in printed order. Join wrapped description lines that
                clearly belong to the same item. For each item, use its final line total, including
                quantity—not its unit price or quantity.

                Do not include subtotal, tax, service charge, discounts, payment, amount tendered,
                or change as purchased items. Use the final amount due as the grand total, not the
                subtotal, tax, or amount tendered.

                Transcribe monetary values exactly as printed: keep every digit and every comma or
                period, and never convert, round, or simplify them yourself. The printed forms
                2.000, 2,000, 2,000.00, and 2.000,00 all mean two thousand and must stay exactly
                as printed so they can be normalized afterwards. Omit only currency symbols and
                unrelated text. For a plain unseparated value, preserve all digits.

                If text or an amount is unreadable or ambiguous, use null for that value. Never
                infer or guess from context.
            '''
            client = openai.OpenAI(
                api_key=openai_api_key,
                timeout=OPENAI_TIMEOUT_SECONDS,
            )
            response = client.chat.completions.create(
                model=RECEIPT_MODEL,
                messages=[
                    {
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': prompt},
                            {'type': 'image_url', 'image_url': {'url': data_url, 'detail': 'high'}},
                        ],
                    }
                ],
                max_completion_tokens=MAX_COMPLETION_TOKENS,
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
                receipt = json.loads(content)
            except json.JSONDecodeError:
                self.send_error(500, 'Failed to parse receipt')
                return

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(receipt).encode())
        except Exception:
            self.send_error(500, 'Failed to process image')
