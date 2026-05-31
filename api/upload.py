import cgi
import json
import os
from http.server import BaseHTTPRequestHandler

from google.cloud import documentai
from google.oauth2 import service_account


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        project_id = os.environ['GOOGLE_PROJECT_ID']
        location = os.environ['GOOGLE_LOCATION']
        processor_id = os.environ['GOOGLE_PROCESSOR_ID']
        sa_json = json.loads(os.environ['GOOGLE_APPLICATION_CREDENTIALS_JSON'])

        form_data = cgi.FieldStorage(
            fp=self.rfile,
            environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': self.headers['Content-Type']})
        if 'file' not in form_data:
            self.send_error(400, 'Missing file')
            return
        file_item = form_data['file']
        image_bytes = file_item.file.read()
        mime_type = file_item.type or 'image/jpeg'

        try:
            credentials = service_account.Credentials.from_service_account_info(sa_json)
            client = documentai.DocumentProcessorServiceClient(credentials=credentials)
            resource_name = client.processor_path(project_id, location, processor_id)

            raw_document = documentai.RawDocument(content=image_bytes, mime_type=mime_type)
            request = documentai.ProcessRequest(name=resource_name, raw_document=raw_document)
            result = client.process_document(request=request)
            document = result.document

            total = None
            items = []

            for entity in document.entities:
                if entity.type_ == 'total_amount' and entity.normalized_value:
                    money = entity.normalized_value.money_value
                    total = money.units + money.nanos / 1e9
                elif entity.type_ == 'line_item':
                    name = ''
                    amount = None
                    for prop in entity.properties:
                        if prop.type_ == 'line_item/description':
                            name = prop.mention_text.strip()
                        elif prop.type_ == 'line_item/amount':
                            if prop.normalized_value:
                                money = prop.normalized_value.money_value
                                amount = money.units + money.nanos / 1e9
                    if name and amount is not None:
                        items.append({'name': name, 'amount': f'{amount:.2f}'})

            response = {
                'total': f'{total:.2f}' if total is not None else None,
                'items': items,
            }

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        except Exception as e:
            self.send_error(500, f'Failed to process image: {str(e)}')
