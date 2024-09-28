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
                Attached is a receipt image, which indicates a purchase.
                Extract the grand total (including tax and charges).
                Also extract the line items, only as amounts (row totals).
                Format the result as an object, with 2 fields: "total" (number) and "items" (array of numbers).
                Only return plain and minified JSON, which should be parseable (do not wrap in code blocks).
                If the image is not a receipt, or no data can be extracted, respond with "Invalid image".

                Valid response:
                {
                  "total": 73150,
                  "items": [30000, 27500, 9000]
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
