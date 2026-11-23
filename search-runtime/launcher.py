"""Private Athena WSGI host. Configuration arrives only over parent-owned stdin."""
import hmac
import json
import logging
import os
from pathlib import Path
import sys
import threading
import tempfile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'source'))
config = json.loads(sys.stdin.readline())
os.environ['SEARXNG_SETTINGS_PATH'] = config['settings']
tempfile.tempdir = config['cache']
sys.dont_write_bytecode = True
server = None
def parent_lifetime():
    # Start watching before imports/engine initialization as well as serving.
    sys.stdin.read()
    if server is not None:
        server.close()
    os._exit(0)
threading.Thread(target=parent_lifetime, daemon=True).start()
# No requests, query strings, result content or secrets in child logs.
logging.disable(logging.CRITICAL)
from searx.webapp import app
from waitress import create_server

token = config['token']
def private_app(environ, start_response):
    if (environ.get('REMOTE_ADDR') != '127.0.0.1'
        or environ.get('HTTP_ORIGIN')
        or not hmac.compare_digest(environ.get('HTTP_AUTHORIZATION', ''), 'Bearer ' + token)):
        start_response('403 Forbidden', [('Content-Type', 'text/plain')])
        return [b'Forbidden']
    path = environ.get('PATH_INFO')
    if path == '/healthz':
        start_response('200 OK', [('Content-Type', 'application/json')])
        return [b'{"ready":true}']
    if path != '/search' or environ.get('REQUEST_METHOD') not in ('GET', 'POST'):
        start_response('404 Not Found', [('Content-Type', 'text/plain')])
        return [b'Not found']
    return app(environ, start_response)

# OS atomically selects a free port; never probe-and-rebind a fixed port.
server = create_server(private_app, host='127.0.0.1', port=0, threads=4,
                       max_request_body_size=8192, channel_timeout=35)
print(json.dumps({'port': int(server.effective_port)}), flush=True)
server.run()
