"""
SmartGlasses AI — API Proxy Server
Securely proxies requests to MiniMax (and other AI providers) so the API key
never leaves the server and is never embedded in the mobile app bundle.
"""
import os
import time
import json
import asyncio
import tempfile
import logging
import subprocess
import threading
import hmac
from functools import wraps
from collections import defaultdict

from flask import Flask, request, jsonify, Response, g, stream_with_context
from dotenv import load_dotenv
import requests as http_client
import edge_tts
from auth_store import DeviceAuthStore

load_dotenv()

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('proxy')

# ── Configuration ───────────────────────────────────────────
MINIMAX_API_KEY = os.getenv('MINIMAX_API_KEY', '')
OPENCODE_API_KEY = os.getenv('OPENCODE_API_KEY', '')
OPENCODE_BASE_URL = os.getenv('OPENCODE_BASE_URL', 'https://opencode.ai/zen/go/v1')
HERMES_API_KEY = os.getenv('HERMES_API_KEY', '')
HERMES_API_BASE_URL = os.getenv('HERMES_API_BASE_URL', 'http://127.0.0.1:8642/v1')
HERMES_API_ROOT_URL = HERMES_API_BASE_URL.rstrip('/')[:-3] if HERMES_API_BASE_URL.rstrip('/').endswith('/v1') else HERMES_API_BASE_URL.rstrip('/')
HERMES_MODEL = os.getenv('HERMES_MODEL', 'deepseek-v4-flash')
HERMES_TIMEOUT_SECONDS = int(os.getenv('HERMES_TIMEOUT_SECONDS', '120'))
HERMES_SWITCH_MODELS_ENABLED = os.getenv('HERMES_SWITCH_MODELS_ENABLED', 'false').lower() in {'1', 'true', 'yes'}
HERMES_CONFIG_PATH = os.getenv('HERMES_CONFIG_PATH', '/opt/hermes/config.yaml')
HERMES_MICROMAMBA_BIN = os.getenv('HERMES_MICROMAMBA_BIN', '/opt/micromamba/bin/micromamba')
HERMES_ENV_PREFIX = os.getenv('HERMES_ENV_PREFIX', '/opt/micromamba/envs/hermes')
HERMES_SERVICE_NAME = os.getenv('HERMES_SERVICE_NAME', 'hermes-agent.service')
HERMES_OPENCODE_CONTEXT_LENGTH = os.getenv('HERMES_OPENCODE_CONTEXT_LENGTH', '65536')

# ── xAI (Grok) Realtime Voice ──────────────────────────────
# The master key stays server-side. The app only ever receives a short-lived
# ephemeral token (xai-client-secret.*) that lets it open a realtime WebSocket
# directly against api.x.ai — the bidirectional audio never bounces through us,
# which keeps latency low and the master key out of the mobile bundle.
XAI_API_KEY = os.getenv('XAI_API_KEY', '')
XAI_REALTIME_MODEL = os.getenv('XAI_REALTIME_MODEL', 'grok-voice-latest')
XAI_CLIENT_SECRETS_URL = os.getenv(
    'XAI_CLIENT_SECRETS_URL', 'https://api.x.ai/v1/realtime/client_secrets'
)
XAI_REALTIME_WS_URL = os.getenv(
    'XAI_REALTIME_WS_URL', 'wss://api.x.ai/v1/realtime'
)
XAI_TOKEN_TTL_SECONDS = int(os.getenv('XAI_TOKEN_TTL_SECONDS', '300'))
OPENCODE_GO_MODELS = {
    item.strip()
    for item in os.getenv(
        'OPENCODE_GO_MODELS',
        'kimi-k2.6,kimi-k2.5,deepseek-v4-pro,deepseek-v4-flash,glm-5.1,glm-5,mimo-v2.5-pro,mimo-v2.5,mimo-v2-pro,mimo-v2-omni,minimax-m2.7,minimax-m2.5,qwen3.6-plus,qwen3.5-plus',
    ).split(',')
    if item.strip()
}
APP_TOKEN = os.getenv('APP_TOKEN', '')  # shared secret between app ↔ proxy
DEVICE_AUTH_ENABLED = os.getenv('DEVICE_AUTH_ENABLED', 'false').lower() in {'1', 'true', 'yes'}
ALLOW_LEGACY_APP_TOKEN = os.getenv('ALLOW_LEGACY_APP_TOKEN', 'false').lower() in {'1', 'true', 'yes'}
AUTH_DB_PATH = os.getenv('AUTH_DB_PATH', os.path.join(os.path.dirname(__file__), 'auth.sqlite3'))
AUTH_TOKEN_PEPPER = os.getenv('AUTH_TOKEN_PEPPER') or APP_TOKEN or 'smartglasses-dev-pepper'
DEVICE_TOKEN_TTL_DAYS = int(os.getenv('DEVICE_TOKEN_TTL_DAYS', '365'))
PORT = int(os.getenv('PORT', '5050'))
CORS_ORIGINS = [origin.strip() for origin in os.getenv('CORS_ORIGINS', '*').split(',') if origin.strip()]
MAX_REQUEST_BYTES = int(os.getenv('MAX_REQUEST_BYTES', '262144'))
KOKORO_ENABLED = os.getenv('KOKORO_ENABLED', 'false').lower() in {'1', 'true', 'yes'}

MINIMAX_CHAT_URL = 'https://api.minimax.io/anthropic/v1/messages'
MINIMAX_TTS_URL = 'https://api.minimaxi.com/v1/t2a_v2'

# Rate limiting: max requests per minute per client IP
RATE_LIMIT = int(os.getenv('RATE_LIMIT', '30'))
_rate_buckets: dict[str, list[float]] = defaultdict(list)
_model_switch_lock = threading.Lock()
_auth_store = DeviceAuthStore(AUTH_DB_PATH, AUTH_TOKEN_PEPPER, DEVICE_TOKEN_TTL_DAYS)
_auth_store.init()
_kokoro_pipelines: dict[str, object] = {}
app.config['MAX_CONTENT_LENGTH'] = MAX_REQUEST_BYTES


def _get_opencode_key() -> str:
    return OPENCODE_API_KEY


def _get_hermes_key() -> str:
    return HERMES_API_KEY


def _clean_config_value(value: str) -> str:
    return value.split('#', 1)[0].strip().strip('"').strip("'")


def _read_hermes_runtime_model() -> tuple[str | None, str | None]:
    """Read provider/model from the Hermes config without adding a YAML dependency."""
    provider = None
    model = None
    in_model_block = False
    try:
        with open(HERMES_CONFIG_PATH, 'r', encoding='utf-8') as config_file:
            for raw_line in config_file:
                if raw_line.startswith('model:'):
                    in_model_block = True
                    continue
                if in_model_block and raw_line.strip() and not raw_line.startswith((' ', '\t')):
                    break
                if not in_model_block:
                    continue
                stripped = raw_line.strip()
                if stripped.startswith('provider:'):
                    provider = _clean_config_value(stripped.split(':', 1)[1])
                elif stripped.startswith('default:'):
                    model = _clean_config_value(stripped.split(':', 1)[1])
    except OSError as exc:
        logger.warning('Could not read Hermes config %s: %s', HERMES_CONFIG_PATH, exc)
    return provider, model


def _read_hermes_runtime_snapshot() -> dict:
    provider, model = _read_hermes_runtime_model()
    return {
        'provider': provider,
        'model': model,
        'allowed_models': sorted(OPENCODE_GO_MODELS),
        'switching_enabled': HERMES_SWITCH_MODELS_ENABLED,
        'context_length': HERMES_OPENCODE_CONTEXT_LENGTH,
    }


def _run_hermes_config_set(key: str, value: str) -> None:
    subprocess.run(
        [HERMES_MICROMAMBA_BIN, 'run', '-p', HERMES_ENV_PREFIX, 'hermes', 'config', 'set', key, value],
        check=True,
        text=True,
        capture_output=True,
        timeout=60,
    )


def _restart_hermes_gateway() -> None:
    subprocess.run(
        ['systemctl', '--user', 'restart', HERMES_SERVICE_NAME],
        check=True,
        text=True,
        capture_output=True,
        timeout=30,
    )
    deadline = time.time() + 25
    health_url = f'{HERMES_API_BASE_URL.rstrip("/")}/health'
    headers = {'Authorization': f'Bearer {HERMES_API_KEY}'} if HERMES_API_KEY else {}
    while time.time() < deadline:
        try:
            resp = http_client.get(health_url, headers=headers, timeout=2)
            if resp.ok:
                return
        except http_client.exceptions.RequestException:
            pass
        time.sleep(1)
    raise TimeoutError('Hermes API did not become healthy after model switch')


def _switch_hermes_to_opencode_go(model: str):
    provider, current_model = _read_hermes_runtime_model()
    if provider == 'opencode-go' and current_model == model:
        return None

    logger.info('Switching Hermes runtime model: %s/%s -> opencode-go/%s', provider, current_model, model)
    try:
        _run_hermes_config_set('model.provider', 'opencode-go')
        _run_hermes_config_set('model.default', model)
        _run_hermes_config_set('model.base_url', 'https://opencode.ai/zen/go/v1')
        _run_hermes_config_set('model.context_length', HERMES_OPENCODE_CONTEXT_LENGTH)
        _run_hermes_config_set('auxiliary.compression.context_length', HERMES_OPENCODE_CONTEXT_LENGTH)
        _restart_hermes_gateway()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, TimeoutError) as exc:
        logger.error('Hermes model switch failed: %s', exc)
        return jsonify({'error': f'Could not switch Hermes to OpenCode Go model {model}'}), 502
    return None


def _ensure_hermes_model(model: str):
    if not HERMES_SWITCH_MODELS_ENABLED or model in {'', 'hermes-agent'}:
        return None
    if model not in OPENCODE_GO_MODELS:
        return jsonify({'error': f'Hermes model not allowed: {model}'}), 400
    with _model_switch_lock:
        return _switch_hermes_to_opencode_go(model)


def _validate_messages(messages) -> tuple[bool, str]:
    if not isinstance(messages, list) or not messages:
        return False, 'messages must be a non-empty array'
    if len(messages) > 32:
        return False, 'messages array is too long'
    for message in messages:
        if not isinstance(message, dict):
            return False, 'each message must be an object'
        if message.get('role') not in {'system', 'user', 'assistant'}:
            return False, 'invalid message role'
        content = message.get('content', '')
        if isinstance(content, str):
            if len(content) > 20000:
                return False, 'message content is too long'
        elif isinstance(content, list):
            if len(json.dumps(content)) > 30000:
                return False, 'message content parts are too large'
        else:
            return False, 'message content must be text or content parts'
    return True, ''


def _cors_origin():
    origin = request.headers.get('Origin', '')
    if '*' in CORS_ORIGINS:
        return origin or '*'
    return origin if origin in CORS_ORIGINS else None


# ── Middleware ──────────────────────────────────────────────
def _extract_proxy_token() -> str:
    auth = request.headers.get('Authorization', '')
    if auth.lower().startswith('bearer '):
        return auth.split(' ', 1)[1].strip()
    return request.headers.get('X-App-Token', '').strip()


def _legacy_auth_context() -> dict:
    return {
        'id': 'legacy-app-token',
        'name': 'Legacy App Token',
        'scopes': ['all'],
        'expires_at': 0,
        'last_seen_at': None,
    }


def _authenticate_request(scope: str):
    token = _extract_proxy_token()
    if not DEVICE_AUTH_ENABLED:
        if not APP_TOKEN or (token and hmac.compare_digest(token, APP_TOKEN)):
            g.auth_context = _legacy_auth_context()
            return None
        logger.warning('Unauthorized legacy-token request from %s', request.remote_addr)
        return jsonify({'error': 'Unauthorized'}), 401

    if ALLOW_LEGACY_APP_TOKEN and APP_TOKEN and token and hmac.compare_digest(token, APP_TOKEN):
        g.auth_context = _legacy_auth_context()
        return None

    auth_context, reason = _auth_store.authenticate(token, scope)
    if auth_context is None:
        status = 403 if reason == 'insufficient_scope' else 401
        logger.warning('Unauthorized device request from %s: %s', request.remote_addr, reason)
        return jsonify({'error': 'Unauthorized', 'reason': reason}), status

    g.auth_context = auth_context
    return None


def require_auth(arg=None):
    """Verify the request comes from a registered device token."""
    scope = 'chat'

    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            auth_error = _authenticate_request(scope)
            if auth_error is not None:
                return auth_error
            return f(*args, **kwargs)
        return decorated

    if callable(arg):
        return decorator(arg)
    if isinstance(arg, str) and arg:
        scope = arg
    return decorator


def rate_limit(f):
    """Simple in-memory rate limiter per authenticated device or client IP."""
    @wraps(f)
    def decorated(*args, **kwargs):
        ip = request.remote_addr or 'unknown'
        auth_context = getattr(g, 'auth_context', None)
        bucket_key = f'device:{auth_context["id"]}' if auth_context else f'ip:{ip}'
        now = time.time()
        window = [t for t in _rate_buckets[bucket_key] if now - t < 60]
        if len(window) >= RATE_LIMIT:
            logger.warning('Rate limited: %s (%d req/min)', bucket_key, len(window))
            return jsonify({'error': 'Rate limited. Try again in a minute.'}), 429
        window.append(now)
        _rate_buckets[bucket_key] = window
        return f(*args, **kwargs)
    return decorated


@app.after_request
def add_cors_headers(response):
    origin = _cors_origin()
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-App-Token, X-Hermes-Session-Id, X-Hermes-Session-Key, X-Hermes-Client, Idempotency-Key'
    response.headers['Access-Control-Max-Age'] = '600'
    return response


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({'error': 'Request body too large'}), 413


# ── Routes ──────────────────────────────────────────────────
@app.route('/health', methods=['OPTIONS'])
@app.route('/api/v1/<path:_path>', methods=['OPTIONS'])
def preflight(_path=None):
    return ('', 204)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'service': 'smartglasses-proxy',
        'device_auth_enabled': DEVICE_AUTH_ENABLED,
        'minimax_configured': bool(MINIMAX_API_KEY),
        'opencode_configured': bool(OPENCODE_API_KEY),
        'hermes_configured': bool(HERMES_API_KEY),
        'xai_configured': bool(XAI_API_KEY),
        'kokoro_enabled': KOKORO_ENABLED,
    })


@app.route('/api/v1/auth/pair', methods=['POST'])
@rate_limit
def pair_device():
    if not DEVICE_AUTH_ENABLED:
        return jsonify({'error': 'Device auth is not enabled'}), 400
    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    code = str(body.get('code', '')).strip()
    device_name = str(body.get('device_name', 'iPhone')).strip()[:80] or 'iPhone'
    result, reason = _auth_store.redeem_pairing_code(
        code,
        device_name,
        request.headers.get('User-Agent', ''),
    )
    if result is None:
        logger.warning('Pairing failed from %s: %s', request.remote_addr, reason)
        return jsonify({'error': 'Invalid pairing code', 'reason': reason}), 401

    logger.info('Paired proxy device: %s (%s)', result['device_name'], result['device_id'])
    return jsonify({'status': 'ok', **result})


@app.route('/api/v1/auth/status', methods=['GET'])
@require_auth('status')
def auth_status():
    auth_context = getattr(g, 'auth_context', _legacy_auth_context())
    return jsonify({
        'status': 'ok',
        'device_auth_enabled': DEVICE_AUTH_ENABLED,
        'device': auth_context,
    })


@app.route('/api/v1/auth/revoke-self', methods=['POST'])
@require_auth('status')
def revoke_self():
    auth_context = getattr(g, 'auth_context', None)
    if not auth_context or auth_context.get('id') == 'legacy-app-token':
        return jsonify({'error': 'No registered device token to revoke'}), 400
    revoked = _auth_store.revoke_device(auth_context['id'])
    return jsonify({'status': 'ok', 'revoked': revoked})


@app.route('/api/v1/chat', methods=['POST'])
@require_auth('chat')
@rate_limit
def proxy_chat():
    """Proxy chat requests to MiniMax (Anthropic-compatible format)."""
    if not MINIMAX_API_KEY:
        return jsonify({'error': 'MiniMax API key not configured on server'}), 500

    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    # Validate required fields
    if 'messages' not in body or 'model' not in body:
        return jsonify({'error': 'Missing required fields: model, messages'}), 400

    # Sanitize: only forward expected fields
    payload = {
        'model': body['model'],
        'messages': body['messages'],
        'max_tokens': min(body.get('max_tokens', 1024), 4096),
    }
    if 'system' in body:
        payload['system'] = body['system']

    logger.info('Chat request: model=%s, messages=%d, ip=%s',
                payload['model'], len(payload['messages']), request.remote_addr)

    t0 = time.time()
    try:
        resp = http_client.post(
            MINIMAX_CHAT_URL,
            headers={
                'Content-Type': 'application/json',
                'x-api-key': MINIMAX_API_KEY,
                'anthropic-version': '2023-06-01',
            },
            json=payload,
            timeout=30,
        )
    except http_client.exceptions.Timeout:
        logger.error('MiniMax timeout after 30s')
        return jsonify({'error': 'AI service timeout'}), 504
    except http_client.exceptions.RequestException as e:
        logger.error('MiniMax request failed: %s', e)
        return jsonify({'error': 'AI service unavailable'}), 502

    elapsed = int((time.time() - t0) * 1000)
    logger.info('Chat response: status=%d, time=%dms', resp.status_code, elapsed)

    # Forward the response as-is (Anthropic format)
    return Response(
        resp.content,
        status=resp.status_code,
        content_type=resp.headers.get('Content-Type', 'application/json'),
    )


def _proxy_opencode(path: str):
    """Proxy OpenCode Go requests. The key can live on the server or arrive as a bearer token."""
    api_key = _get_opencode_key()
    if not api_key:
        return jsonify({'error': 'OpenCode API key not configured'}), 500

    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    if 'messages' not in body or 'model' not in body:
        return jsonify({'error': 'Missing required fields: model, messages'}), 400

    allowed_fields = {
        'model',
        'messages',
        'system',
        'max_tokens',
        'temperature',
        'top_p',
        'stop',
        'stream',
    }
    payload = {key: value for key, value in body.items() if key in allowed_fields}
    should_stream = bool(payload.get('stream'))
    if 'max_tokens' in payload:
        payload['max_tokens'] = min(int(payload.get('max_tokens') or 1024), 4096)

    logger.info('OpenCode request: path=%s, model=%s, messages=%d, ip=%s',
                path, payload['model'], len(payload['messages']), request.remote_addr)

    t0 = time.time()
    try:
        resp = http_client.post(
            f'{OPENCODE_BASE_URL.rstrip("/")}/{path.lstrip("/")}',
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}',
                'x-api-key': api_key,
                'anthropic-version': request.headers.get('anthropic-version', '2023-06-01'),
            },
            json=payload,
            timeout=30,
            stream=should_stream,
        )
    except http_client.exceptions.Timeout:
        logger.error('OpenCode timeout after 30s')
        return jsonify({'error': 'OpenCode service timeout'}), 504
    except http_client.exceptions.RequestException as e:
        logger.error('OpenCode request failed: %s', e)
        return jsonify({'error': 'OpenCode service unavailable'}), 502

    elapsed = int((time.time() - t0) * 1000)
    logger.info('OpenCode response: status=%d, time=%dms', resp.status_code, elapsed)

    if should_stream:
        return Response(
            stream_with_context(resp.iter_content(chunk_size=None)),
            status=resp.status_code,
            content_type=resp.headers.get('Content-Type', 'text/event-stream'),
        )

    return Response(resp.content, status=resp.status_code, content_type=resp.headers.get('Content-Type', 'application/json'))


@app.route('/api/v1/opencode/chat/completions', methods=['POST'])
@require_auth('chat')
@rate_limit
def proxy_opencode_chat():
    return _proxy_opencode('chat/completions')


@app.route('/api/v1/opencode/messages', methods=['POST'])
@require_auth('chat')
@rate_limit
def proxy_opencode_messages():
    return _proxy_opencode('messages')


def _hermes_headers(api_key: str) -> dict[str, str]:
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
        'X-Hermes-Client': request.headers.get('X-Hermes-Client', 'smartglasses-proxy'),
    }
    for name in ('X-Hermes-Session-Id', 'X-Hermes-Session-Key', 'Idempotency-Key'):
        value = request.headers.get(name)
        if value:
            headers[name] = value
    return headers


def _proxy_hermes_json(path: str, body: dict | None = None, method: str = 'POST'):
    api_key = _get_hermes_key()
    if not api_key:
        return jsonify({'error': 'Hermes API key not configured'}), 500

    base_url = HERMES_API_ROOT_URL if path.startswith('/api/') else HERMES_API_BASE_URL.rstrip('/')
    url = f'{base_url}/{path.lstrip("/")}'
    should_stream = method == 'POST' and bool((body or {}).get('stream'))
    t0 = time.time()
    try:
        resp = http_client.request(
            method,
            url,
            headers=_hermes_headers(api_key),
            json=body,
            timeout=HERMES_TIMEOUT_SECONDS,
            stream=should_stream,
        )
    except http_client.exceptions.Timeout:
        logger.error('Hermes timeout after %ss: path=%s', HERMES_TIMEOUT_SECONDS, path)
        return jsonify({'error': 'Hermes service timeout'}), 504
    except http_client.exceptions.RequestException as e:
        logger.error('Hermes request failed: %s', e)
        return jsonify({'error': 'Hermes service unavailable'}), 502

    elapsed = int((time.time() - t0) * 1000)
    logger.info('Hermes response: path=%s status=%d time=%dms', path, resp.status_code, elapsed)
    if should_stream:
        return Response(
            stream_with_context(resp.iter_content(chunk_size=None)),
            status=resp.status_code,
            content_type=resp.headers.get('Content-Type', 'text/event-stream'),
        )

    return Response(resp.content, status=resp.status_code, content_type=resp.headers.get('Content-Type', 'application/json'))


@app.route('/api/v1/hermes/health', methods=['GET'])
@require_auth('status')
def proxy_hermes_health():
    api_key = _get_hermes_key()
    if not api_key:
        return jsonify({'error': 'Hermes API key not configured'}), 500
    try:
        resp = http_client.get(
            f'{HERMES_API_BASE_URL.rstrip("/")}/health',
            headers={'Authorization': f'Bearer {api_key}'},
            timeout=5,
        )
    except http_client.exceptions.RequestException as e:
        logger.error('Hermes health failed: %s', e)
        return jsonify({'error': 'Hermes service unavailable'}), 502
    return Response(resp.content, status=resp.status_code, content_type=resp.headers.get('Content-Type', 'application/json'))


@app.route('/api/v1/hermes/status', methods=['GET'])
@require_auth('status')
def proxy_hermes_status():
    api_key = _get_hermes_key()
    if not api_key:
        return jsonify({'error': 'Hermes API key not configured'}), 500

    status = {
        'status': 'unknown',
        'service': 'hermes',
        'runtime': _read_hermes_runtime_snapshot(),
        'capabilities': None,
    }
    headers = {'Authorization': f'Bearer {api_key}'}
    try:
        health_resp = http_client.get(f'{HERMES_API_BASE_URL.rstrip("/")}/health', headers=headers, timeout=5)
        status['status'] = 'ok' if health_resp.ok else 'error'
        status['health_status_code'] = health_resp.status_code
    except http_client.exceptions.RequestException as e:
        status['status'] = 'error'
        status['error'] = str(e)

    try:
        cap_resp = http_client.get(f'{HERMES_API_BASE_URL.rstrip("/")}/capabilities', headers=headers, timeout=5)
        if cap_resp.ok:
            status['capabilities'] = cap_resp.json()
    except (http_client.exceptions.RequestException, ValueError):
        pass

    return jsonify(status), 200 if status['status'] == 'ok' else 502


@app.route('/api/v1/hermes/capabilities', methods=['GET'])
@require_auth('status')
def proxy_hermes_capabilities():
    api_key = _get_hermes_key()
    if not api_key:
        return jsonify({'error': 'Hermes API key not configured'}), 500
    try:
        resp = http_client.get(
            f'{HERMES_API_BASE_URL.rstrip("/")}/capabilities',
            headers={'Authorization': f'Bearer {api_key}'},
            timeout=5,
        )
    except http_client.exceptions.RequestException as e:
        logger.error('Hermes capabilities failed: %s', e)
        return jsonify({'error': 'Hermes service unavailable'}), 502
    return Response(resp.content, status=resp.status_code, content_type=resp.headers.get('Content-Type', 'application/json'))


@app.route('/api/v1/hermes/model', methods=['GET', 'POST'])
@require_auth('model')
@rate_limit
def proxy_hermes_model():
    if request.method == 'GET':
        return jsonify(_read_hermes_runtime_snapshot())

    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400
    requested_model = str(body.get('model', '')).strip()
    if not requested_model:
        return jsonify({'error': 'Missing required field: model'}), 400

    switch_error = _ensure_hermes_model(requested_model)
    if switch_error is not None:
        return switch_error
    return jsonify(_read_hermes_runtime_snapshot())


@app.route('/api/v1/hermes/chat/completions', methods=['POST'])
@require_auth('chat')
@rate_limit
def proxy_hermes_chat():
    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    if 'messages' not in body:
        return jsonify({'error': 'Missing required field: messages'}), 400
    messages_ok, messages_error = _validate_messages(body.get('messages'))
    if not messages_ok:
        return jsonify({'error': messages_error}), 400

    allowed_fields = {
        'model',
        'messages',
        'max_tokens',
        'temperature',
        'top_p',
        'stop',
        'stream',
    }
    payload = {key: value for key, value in body.items() if key in allowed_fields}
    payload['model'] = payload.get('model') or HERMES_MODEL
    payload['stream'] = bool(payload.get('stream'))
    if 'max_tokens' in payload:
        payload['max_tokens'] = min(int(payload.get('max_tokens') or 1024), 4096)

    switch_error = _ensure_hermes_model(str(payload['model']))
    if switch_error is not None:
        return switch_error

    logger.info('Hermes chat request: model=%s, messages=%d, ip=%s',
                payload['model'], len(payload['messages']), request.remote_addr)
    return _proxy_hermes_json('chat/completions', payload)


@app.route('/api/v1/hermes/responses', methods=['POST'])
@require_auth('chat')
@rate_limit
def proxy_hermes_responses():
    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400
    body['model'] = body.get('model') or HERMES_MODEL
    body['stream'] = bool(body.get('stream'))
    switch_error = _ensure_hermes_model(str(body['model']))
    if switch_error is not None:
        return switch_error
    return _proxy_hermes_json('responses', body)


@app.route('/api/v1/hermes/jobs', methods=['GET', 'POST'])
@app.route('/api/v1/hermes/jobs/<path:job_path>', methods=['GET', 'PATCH', 'DELETE', 'POST'])
@require_auth('jobs')
@rate_limit
def proxy_hermes_jobs(job_path: str | None = None):
    body = None
    if request.method in {'POST', 'PATCH'}:
        try:
            body = request.get_json(force=True)
        except Exception:
            return jsonify({'error': 'Invalid JSON body'}), 400
    path = f'/api/jobs/{job_path}' if job_path else '/api/jobs'
    return _proxy_hermes_json(path, body, request.method)


@app.route('/api/v1/tts', methods=['POST'])
@require_auth('tts')
@rate_limit
def proxy_tts():
    """Proxy TTS requests to MiniMax T2A."""
    if not MINIMAX_API_KEY:
        return jsonify({'error': 'MiniMax API key not configured on server'}), 500

    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    logger.info('TTS request: ip=%s', request.remote_addr)

    try:
        resp = http_client.post(
            MINIMAX_TTS_URL,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {MINIMAX_API_KEY}',
            },
            json=body,
            timeout=30,
        )
    except http_client.exceptions.RequestException as e:
        logger.error('MiniMax TTS failed: %s', e)
        return jsonify({'error': 'TTS service unavailable'}), 502

    return Response(
        resp.content,
        status=resp.status_code,
        content_type=resp.headers.get('Content-Type', 'application/json'),
    )


# ── Edge TTS (high-quality neural voices, free) ────────────
ALLOWED_EDGE_VOICES = {
    'es-ES-AlvaroNeural', 'es-ES-ElviraNeural',
    'es-MX-DaliaNeural', 'es-MX-JorgeNeural',
    'es-AR-ElenaNeural', 'es-AR-TomasNeural',
    'en-US-GuyNeural', 'en-US-JennyNeural',
    'en-US-AriaNeural', 'en-GB-RyanNeural',
}

ALLOWED_KOKORO_VOICES = {
    'ef_dora': 'e',
    'em_alex': 'e',
    'em_santa': 'e',
    'af_heart': 'a',
    'am_adam': 'a',
}


def _run_async(coro):
    """Run an async coroutine from synchronous Flask context."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _synthesize_edge(text: str, voice: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice)
    tmp = tempfile.NamedTemporaryFile(suffix='.mp3', delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        await communicate.save(tmp_path)
        with open(tmp_path, 'rb') as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _to_soundfile_audio(audio):
    if hasattr(audio, 'detach'):
        return audio.detach().cpu().numpy()
    return audio


def _get_kokoro_pipeline(lang_code: str):
    pipeline = _kokoro_pipelines.get(lang_code)
    if pipeline is not None:
        return pipeline
    from kokoro import KPipeline
    pipeline = KPipeline(lang_code=lang_code)
    _kokoro_pipelines[lang_code] = pipeline
    return pipeline


def _synthesize_kokoro(text: str, voice: str, speed: float) -> bytes:
    import soundfile as sf

    lang_code = ALLOWED_KOKORO_VOICES[voice]
    pipeline = _get_kokoro_pipeline(lang_code)
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        with sf.SoundFile(tmp_path, mode='w', samplerate=24000, channels=1, subtype='PCM_16') as wav_file:
            for _, _, audio in pipeline(text, voice=voice, speed=speed):
                wav_file.write(_to_soundfile_audio(audio))
        with open(tmp_path, 'rb') as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.route('/api/v1/tts/kokoro', methods=['POST'])
@require_auth('tts')
@rate_limit
def proxy_tts_kokoro():
    """Synthesize speech using optional local Kokoro TTS."""
    if not KOKORO_ENABLED:
        return jsonify({'error': 'Kokoro TTS is not enabled on this server'}), 503

    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    text = body.get('text', '').strip()
    voice = body.get('voice', 'ef_dora')
    speed = max(0.75, min(float(body.get('speed', 1.05)), 1.35))

    if not text:
        return jsonify({'error': 'Missing text'}), 400
    if len(text) > 2500:
        return jsonify({'error': 'Text too long (max 2500 chars)'}), 400
    if voice not in ALLOWED_KOKORO_VOICES:
        return jsonify({'error': f'Voice not allowed: {voice}'}), 400

    logger.info('Kokoro TTS request: voice=%s, text_len=%d, ip=%s', voice, len(text), request.remote_addr)
    t0 = time.time()
    try:
        audio_data = _synthesize_kokoro(text, voice, speed)
    except ImportError as e:
        logger.error('Kokoro dependencies missing: %s', e)
        return jsonify({'error': 'Kokoro dependencies are not installed on this server'}), 503
    except Exception as e:
        logger.error('Kokoro TTS failed: %s', e)
        return jsonify({'error': 'Kokoro synthesis failed'}), 500

    elapsed = int((time.time() - t0) * 1000)
    logger.info('Kokoro TTS response: size=%d bytes, time=%dms', len(audio_data), elapsed)
    return Response(audio_data, content_type='audio/wav')


# ── Kokoro TTS — STREAMING (raw PCM16 chunks, sent as each segment is generated) ──
# This is the low-latency variant: instead of buffering the whole phrase into a
# WAV blob, it emits raw PCM16 24kHz mono as Kokoro yields each phoneme chunk.
# The client feeds those bytes straight into the native ring buffer, so playback
# starts on the first chunk (the hypercheap-voiceAI pattern). No WAV container,
# no temp file, no MP3 decode.
KOKORO_STREAM_SAMPLE_RATE = 24000


def _kokoro_pcm16_segments(text: str, voice: str, speed: float):
    """Yield raw PCM16 bytes (24kHz mono) per Kokoro generation chunk."""
    import numpy as np

    lang_code = ALLOWED_KOKORO_VOICES[voice]
    pipeline = _get_kokoro_pipeline(lang_code)
    for _, _, audio in pipeline(text, voice=voice, speed=speed):
        samples = _to_soundfile_audio(audio)
        # Kokoro returns float32 in [-1, 1]. Convert to little-endian PCM16.
        clipped = np.clip(samples, -1.0, 1.0)
        pcm = (clipped * 32767.0).astype('<i2')
        yield pcm.tobytes()


@app.route('/api/v1/tts/kokoro/stream', methods=['POST'])
@require_auth('tts')
@rate_limit
def proxy_tts_kokoro_stream():
    """Streaming Kokoro TTS — raw PCM16 24kHz mono, chunked as generated.

    Response content-type is audio/pcm. The client knows the format from the
    response headers (sample rate / channels / encoding) and can start playback
    on the first bytes. Designed to be called per sentence by the client's
    streaming speaker so TTS overlaps with both LLM generation and playback.
    """
    if not KOKORO_ENABLED:
        return jsonify({'error': 'Kokoro TTS is not enabled on this server'}), 503

    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    text = body.get('text', '').strip()
    voice = body.get('voice', 'ef_dora')
    speed = max(0.75, min(float(body.get('speed', 1.05)), 1.35))

    if not text:
        return jsonify({'error': 'Missing text'}), 400
    if len(text) > 2500:
        return jsonify({'error': 'Text too long (max 2500 chars)'}), 400
    if voice not in ALLOWED_KOKORO_VOICES:
        return jsonify({'error': f'Voice not allowed: {voice}'}), 400

    logger.info('Kokoro STREAM request: voice=%s, text_len=%d, ip=%s',
                voice, len(text), request.remote_addr)
    t0 = time.time()

    def log_when_done():
        logger.info('Kokoro STREAM done: time=%dms', int((time.time() - t0) * 1000))

    response = Response(
        stream_with_context(_kokoro_pcm16_segments(text, voice, speed)),
        content_type='audio/pcm',
        headers={
            'X-Audio-Sample-Rate': str(KOKORO_STREAM_SAMPLE_RATE),
            'X-Audio-Channels': '1',
            'X-Audio-Encoding': 'pcm16',
            'X-Audio-Byte-Order': 'little-endian',
            'Cache-Control': 'no-store',
        },
    )
    response.call_on_close(log_when_done)
    return response


@app.route('/api/v1/tts/edge', methods=['POST'])
@require_auth('tts')
@rate_limit
def proxy_tts_edge():
    """Synthesize speech using Microsoft Edge TTS (free, high-quality neural voices)."""
    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'Invalid JSON body'}), 400

    text = body.get('text', '').strip()
    voice = body.get('voice', 'es-ES-AlvaroNeural')
    rate = body.get('rate', '+0%')
    volume = body.get('volume', '+0%')

    if not text:
        return jsonify({'error': 'Missing text'}), 400
    if len(text) > 5000:
        return jsonify({'error': 'Text too long (max 5000 chars)'}), 400
    if voice not in ALLOWED_EDGE_VOICES:
        return jsonify({'error': f'Voice not allowed: {voice}'}), 400

    logger.info('Edge TTS request: voice=%s, text_len=%d, ip=%s',
                voice, len(text), request.remote_addr)

    t0 = time.time()
    try:
        audio_data = _run_async(_synthesize_edge_with_options(text, voice, rate, volume))
    except Exception as e:
        logger.error('Edge TTS failed: %s', e)
        return jsonify({'error': f'TTS synthesis failed: {str(e)}'}), 500

    elapsed = int((time.time() - t0) * 1000)
    logger.info('Edge TTS response: size=%d bytes, time=%dms', len(audio_data), elapsed)

    return Response(audio_data, content_type='audio/mpeg')


async def _synthesize_edge_with_options(text: str, voice: str, rate: str, volume: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume)
    tmp = tempfile.NamedTemporaryFile(suffix='.mp3', delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        await communicate.save(tmp_path)
        with open(tmp_path, 'rb') as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── xAI (Grok) Realtime Voice — ephemeral session tokens ────
@app.route('/api/v1/xai/realtime/session', methods=['POST'])
@require_auth('chat')
@rate_limit
def xai_realtime_session():
    """Mint a short-lived ephemeral token so the app can open a realtime
    WebSocket directly against x.ai. The master XAI_API_KEY never leaves the
    server; the app only receives the xai-client-secret.* token."""
    if not XAI_API_KEY:
        return jsonify({'error': 'xAI API key not configured on server'}), 500

    ttl = max(30, min(XAI_TOKEN_TTL_SECONDS, 1800))
    # Honour an optional client hint, but clamp it server-side.
    try:
        body = request.get_json(silent=True) or {}
    except Exception:
        body = {}
    if isinstance(body, dict) and isinstance(body.get('ttl'), (int, float)):
        ttl = max(30, min(int(body['ttl']), 1800))

    model = XAI_REALTIME_MODEL
    payload = {
        'model': model,
        'expires_after': {'seconds': ttl},
    }

    logger.info('xAI realtime session request: model=%s ttl=%ss ip=%s', model, ttl, request.remote_addr)
    t0 = time.time()
    try:
        resp = http_client.post(
            XAI_CLIENT_SECRETS_URL,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {XAI_API_KEY}',
            },
            json=payload,
            timeout=15,
        )
    except http_client.exceptions.Timeout:
        logger.error('xAI client_secrets timeout')
        return jsonify({'error': 'xAI service timeout'}), 504
    except http_client.exceptions.RequestException as exc:
        logger.error('xAI client_secrets failed: %s', exc)
        return jsonify({'error': 'xAI service unavailable'}), 502

    if not resp.ok:
        elapsed = int((time.time() - t0) * 1000)
        logger.warning('xAI client_secrets non-2xx: status=%d time=%dms body=%s',
                       resp.status_code, elapsed, resp.text[:300])
        return Response(resp.content, status=resp.status_code,
                        content_type=resp.headers.get('Content-Type', 'application/json'))

    try:
        data = resp.json()
    except ValueError:
        logger.error('xAI client_secrets returned non-JSON body')
        return jsonify({'error': 'xAI returned an unexpected response'}), 502

    # Normalize: pull the ephemeral value out of either xAI's own shape or the
    # OpenAI-compatible client_secret.{value} shape.
    token = None
    if isinstance(data.get('value'), str):
        token = data['value']
    elif isinstance(data.get('client_secret'), dict) and isinstance(data['client_secret'].get('value'), str):
        token = data['client_secret']['value']
    elif isinstance(data.get('ephemeral_token'), str):
        token = data['ephemeral_token']

    if not token:
        logger.error('xAI client_secrets response missing token: %s', str(data)[:300])
        return jsonify({'error': 'xAI did not return an ephemeral token'}), 502

    elapsed = int((time.time() - t0) * 1000)
    logger.info('xAI realtime session: status=%d time=%dms ttl=%ss', resp.status_code, elapsed, ttl)

    return jsonify({
        'ephemeral_token': token,
        'model': model,
        'ws_url': f'{XAI_REALTIME_WS_URL}?model={model}',
        'expires_in': ttl,
    })


if __name__ == '__main__':
    if not MINIMAX_API_KEY:
        logger.warning('⚠️  MINIMAX_API_KEY not set! Proxy will reject all requests.')
    if DEVICE_AUTH_ENABLED and AUTH_TOKEN_PEPPER == 'smartglasses-dev-pepper':
        logger.warning('AUTH_TOKEN_PEPPER is using the development fallback.')
    logger.info('Starting SmartGlasses proxy on port %d', PORT)
    app.run(host='0.0.0.0', port=PORT, debug=False)
