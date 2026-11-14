"""Serve the dashboard, pass the band's events on to the team's device API, and keep a trace.

    python3 serve.py            # then open http://localhost:8001/index.html

It is `python3 -m http.server` plus two things.

/hub/...  goes on to the device API (the-force, docs/api.md): /hub/v1/band/events becomes
          /v1/band/events there. A page cannot call that API itself (another address, and the
          API sends no CORS headers), and this way the session token stays out of the browser.
              BODYOS_API_URL         where the API is. Default http://127.0.0.1:8000
              BODYOS_SESSION_TOKEN   the team's token, if the API was started with one

/trace    the page posts the band's motion and what the gesture detector made of it every
          couple of seconds, and this writes each post as one line of traces/trace.jsonl.
          Motion only: no sound, no keys. The file stays on this computer, and it is started
          again once it passes 30 MB (the one before is kept as trace.old.jsonl).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TRACES = os.path.join(HERE, 'traces')
MAX_BYTES = 30 * 1024 * 1024
MAX_POST = 2 * 1024 * 1024

API_URL = os.getenv('BODYOS_API_URL', 'http://127.0.0.1:8000').rstrip('/')
API_TOKEN = os.getenv('BODYOS_SESSION_TOKEN', '')
# The only API routes a band needs. Nothing else is passed on.
HUB_ROUTES = re.compile(r'^/hub(/healthz|/v1/devices/connect|/v1/devices/[A-Za-z0-9_-]{1,128}|/v1/band/events)(\?[A-Za-z0-9_=&%.-]*)?$')
MAX_HUB_POST = 64 * 1024


class Handler(SimpleHTTPRequestHandler):
    def hub(self, body=None):
        """Pass one request on to the device API and hand its answer back unchanged."""
        if not HUB_ROUTES.match(self.path):
            self.reply(404, {'detail': 'serve.py passes on only the routes a band uses.'})
            return
        headers = {'Accept': 'application/json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if API_TOKEN:
            headers['Authorization'] = 'Bearer ' + API_TOKEN
        key = self.headers.get('Idempotency-Key')
        if key:
            headers['Idempotency-Key'] = key
        request = urllib.request.Request(API_URL + self.path[len('/hub'):], data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(request, timeout=3) as answer:
                self.reply(answer.status, answer.read())
        except urllib.error.HTTPError as error:               # the API answered, with an error: pass it on
            self.reply(error.code, error.read())
        except (urllib.error.URLError, OSError):
            self.reply(502, {'detail': f'The device API at {API_URL} did not answer. Is it running?'})

    def reply(self, status, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/hub/'):
            self.hub()
        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        if self.path.startswith('/hub/'):
            if not 0 < length <= MAX_HUB_POST:
                self.reply(413, {'detail': 'A band event is a small JSON body.'})
                return
            self.hub(self.rfile.read(length))
            return
        if self.path != '/trace' or not 0 < length <= MAX_POST:
            self.send_error(404)
            return
        body = self.rfile.read(length).replace(b'\n', b' ')
        os.makedirs(TRACES, exist_ok=True)
        path = os.path.join(TRACES, 'trace.jsonl')
        if os.path.exists(path) and os.path.getsize(path) > MAX_BYTES:
            os.replace(path, os.path.join(TRACES, 'trace.old.jsonl'))
        with open(path, 'ab') as file:
            file.write(body + b'\n')
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')      # always the newest page and scripts
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 64                                # a page asks for many scripts at once
    daemon_threads = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    print(f'Dashboard: http://localhost:{port}/index.html')
    print(f'Device API: {API_URL} ' + ('with the session token' if API_TOKEN else 'without a session token') + f'. Traces: {TRACES}')
    Server(('127.0.0.1', port), partial(Handler, directory=HERE)).serve_forever()
