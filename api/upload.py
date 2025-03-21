import cgi
from http.server import BaseHTTPRequestHandler
import json
import os

import openai
import requests


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        uplass_app_key = os.environ['UPLASS_APP_KEY']
        uplass_app_secret = os.environ['UPLASS_APP_SECRET']
        openai_api_key = os.environ['OPENAI_API_KEY']

        # Parse multipart form data
        form_data = cgi.FieldStorage(
            fp=self.rfile,
            environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': self.headers['Content-Type']})
        if 'file' not in form_data:
            self.send_error(400, 'Missing file')
            return
        file_item = form_data['file']

        # Get token from Uplass
        url = 'https://uplass.kvn.ovh/token'
        data = {'AppKey': uplass_app_key, 'AppSecret': uplass_app_secret}
        response = requests.post(url, json=data)
        if response.status_code != 200:
            self.send_error(500, 'Failed to get upload token')
            return
        token = response.text

        # Upload image to Uplass
        url = 'https://uplass.kvn.ovh/upload'
        data = {'token': token}
        files = {'file': (file_item.filename, file_item.file.read(), file_item.type)}
        response = requests.post(url, data=data, files=files)
        if response.status_code != 200:
            self.send_error(500, 'Failed to upload image')
            return
        image_url = response.text
        print(f'Image uploaded to: {image_url}')

        # Extract data using ChatGPT
        try:
            prompt = '''
                This is a receipt, which is related to a purchase.
                Extract the item data (name and price of every line) and the grand total (the bottom amount).

                Format the response as a valid JSON, which must be directly parseable (do not wrap in code blocks).
                The response object must have 2 fields:
                  - "total": decimal-string
                  - "items": array of objects containing "name" (string) and "amount" (decimal-string)

                If there are 2 digits after a dot, then it's a decimal separator, else it's a thousands separator.
                If the image is not a receipt or data extraction failed, respond with "None".

                Sample response:
                {
                  "total": "73150.00",
                  "items": [
                    {"name": "Porridge", "amount": "30000.00"},
                    {"name": "Noddle", "amount": "27500.00"},
                    {"name": "Coffee", "amount": "9000.00"}
                  ]
                }
            '''
            client = openai.OpenAI(api_key=openai_api_key)
            response = client.chat.completions.create(
                model='gpt-4o-mini',
                messages=[
                    {
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': prompt},
                            {'type': 'image_url', 'image_url': {'url': image_url}},
                        ],
                    }
                ],
                max_tokens=500,
            )
            items = json.loads(response.choices[0].message.content)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(items).encode())
        except Exception as e:
            self.send_error(500, f'Failed to process image: {str(e)}')
