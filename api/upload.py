import base64
import io
import json
import logging
import os
from http.server import BaseHTTPRequestHandler

import openai
from PIL import Image


MAX_REQUEST_BYTES = 10 * 1024 * 1024
# Temporary production diagnostics; remove after model compatibility is confirmed.
RECEIPT_MODEL = 'gpt-6-luna'
logger = logging.getLogger(__name__)


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
            stage = 'api_request'
            prompt = '''
                Extract each line item and the grand total from this purchase receipt.
                Return ONLY raw JSON (no markdown, no code blocks):
                {
                    "total": "60500.00",
                    "items": [{"name": "Noodle", "amount": "30000.00"}, {"name": "Coffee", "amount": "25000.00"}]
                }

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
            )

            stage = 'response_validation'
            if not response.choices:
                logger.error('Receipt model returned no choices (model=%s)', RECEIPT_MODEL)
                self.send_error(500, 'Failed to process image')
                return

            choice = response.choices[0]
            content = choice.message.content
            if not isinstance(content, str) or not content.strip():
                logger.error(
                    'Receipt model returned empty content (model=%s, response_id=%r, '
                    'finish_reason=%r, refusal=%s)',
                    RECEIPT_MODEL,
                    getattr(response, 'id', None),
                    choice.finish_reason,
                    bool(getattr(choice.message, 'refusal', None)),
                )
                self.send_error(500, 'Failed to process image')
                return
            content = content.strip()
            if content.startswith('```'):
                content = content.split('\n', 1)[-1].rsplit('```', 1)[0].strip()
            stage = 'response_parse'
            try:
                items = json.loads(content)
            except json.JSONDecodeError:
                logger.error(
                    'Receipt model returned invalid JSON (model=%s, response_id=%r, '
                    'finish_reason=%r, refusal=%s, response_chars=%d)',
                    RECEIPT_MODEL,
                    getattr(response, 'id', None),
                    choice.finish_reason,
                    bool(getattr(choice.message, 'refusal', None)),
                    len(content),
                )
                self.send_error(500, 'Failed to parse receipt')
                return

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(items).encode())
        except openai.APIStatusError as exc:
            logger.error(
                'Receipt API rejected request (model=%s, endpoint=chat.completions, status=%s, '
                'code=%r, param=%r, request_id=%r)',
                RECEIPT_MODEL,
                exc.status_code,
                getattr(exc, 'code', None),
                getattr(exc, 'param', None),
                getattr(exc, 'request_id', None),
            )
            self.send_error(500, 'Failed to process image')
        except openai.APIConnectionError as exc:
            logger.error(
                'Receipt API connection failed (model=%s, cause_type=%s)',
                RECEIPT_MODEL,
                type(exc.__cause__).__name__ if exc.__cause__ else 'unknown',
            )
            self.send_error(500, 'Failed to process image')
        except openai.OpenAIError as exc:
            logger.error(
                'Receipt OpenAI client error (model=%s, error_type=%s)',
                RECEIPT_MODEL,
                type(exc).__name__,
            )
            self.send_error(500, 'Failed to process image')
        except Exception as exc:
            logger.error(
                'Receipt processing failed (stage=%s, error_type=%s)',
                locals().get('stage', 'unknown'),
                type(exc).__name__,
            )
            self.send_error(500, 'Failed to process image')
