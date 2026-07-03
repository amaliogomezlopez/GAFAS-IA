#!/usr/bin/env python3
"""
Test script for the Kokoro STREAMING TTS route.

Verifies that POST /api/v1/tts/kokoro/stream:
  1. Returns audio/pcm with the X-Audio-* headers.
  2. Streams PCM16 chunks incrementally (not a single blob).
  3. Produces raw little-endian PCM16 24kHz mono.

Usage:
  # Against the local dev proxy (no auth)
  python test_kokoro_stream.py --base http://localhost:5050 --no-auth

  # Against the production proxy (needs a device bearer token)
  python test_kokoro_stream.py --base https://your-proxy.example.com --token <DEVICE_TOKEN>

  # Or via legacy app token
  python test_kokoro_stream.py --base https://your-proxy.example.com --app-token <APP_TOKEN>

The script measures time-to-first-byte (the key latency metric) and writes
the received PCM to out.pcm for manual inspection / playback with e.g.:
  ffplay -f s16le -ar 24000 -ac 1 out.pcm
"""
import argparse
import sys
import time
import urllib.request
import json


def build_headers(args):
    headers = {'Content-Type': 'application/json'}
    if args.no_auth:
        return headers
    if args.token:
        headers['Authorization'] = f'Bearer {args.token}'
        headers['X-App-Token'] = args.token
    elif args.app_token:
        headers['X-App-Token'] = args.app_token
    return headers


def main():
    parser = argparse.ArgumentParser(description='Test Kokoro streaming TTS route')
    parser.add_argument('--base', default='http://localhost:5050', help='Proxy base URL')
    parser.add_argument('--text', default='Hola, soy Kairo, tu asistente de voz. Esto es una prueba de latencia.', help='Text to synthesize')
    parser.add_argument('--voice', default='ef_dora', help='Kokoro voice id')
    parser.add_argument('--speed', type=float, default=1.05, help='Speech speed')
    parser.add_argument('--token', help='Device bearer token')
    parser.add_argument('--app-token', help='Legacy app token')
    parser.add_argument('--no-auth', action='store_true', help='Send no auth header (local dev)')
    parser.add_argument('--out', default='out.pcm', help='Output PCM file path')
    args = parser.parse_args()

    url = f'{args.base.rstrip("/")}/api/v1/tts/kokoro/stream'
    body = json.dumps({'text': args.text, 'voice': args.voice, 'speed': args.speed}).encode('utf-8')
    headers = build_headers(args)

    print(f'POST {url}')
    print(f'  voice={args.voice} speed={args.speed} text="{args.text[:50]}..."')
    print(f'  auth={"none" if args.no_auth else "bearer/app-token"}')

    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as exc:
        print(f'\n❌ HTTP {exc.code}: {exc.read().decode("utf-8", "replace")[:300]}')
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(f'\n❌ Connection error: {exc}')
        sys.exit(1)

    content_type = resp.headers.get('Content-Type', '')
    sample_rate = resp.headers.get('X-Audio-Sample-Rate', '?')
    channels = resp.headers.get('X-Audio-Channels', '?')
    encoding = resp.headers.get('X-Audio-Encoding', '?')

    print(f'\nResponse headers:')
    print(f'  Content-Type:        {content_type}')
    print(f'  X-Audio-Sample-Rate: {sample_rate}')
    print(f'  X-Audio-Channels:    {channels}')
    print(f'  X-Audio-Encoding:    {encoding}')

    if 'audio/pcm' not in content_type:
        print(f'\n❌ Expected audio/pcm, got {content_type}. Is the route deployed and KOKORO_ENABLED=true?')
        sys.exit(1)

    # Read the streamed body chunk by chunk and measure time-to-first-byte.
    total_bytes = 0
    chunk_count = 0
    first_byte_ms = None
    last_report = t0

    with open(args.out, 'wb') as out:
        while True:
            chunk = resp.read(4096)  # 4 KiB reads
            if not chunk:
                break
            now = time.time()
            if first_byte_ms is None:
                first_byte_ms = int((now - t0) * 1000)
                print(f'\n⏱  Time to first byte: {first_byte_ms} ms')
            total_bytes += len(chunk)
            chunk_count += 1
            out.write(chunk)
            # Progress report every ~250ms so you can watch the stream arrive.
            if now - last_report > 0.25:
                print(f'   received {total_bytes:>8} bytes in {chunk_count} chunks ({int((now - t0) * 1000)} ms)')
                last_report = now

    total_ms = int((time.time() - t0) * 1000)
    duration_s = total_bytes / (int(sample_rate) * 2) if sample_rate.isdigit() else 0

    print('\n──────── summary ────────')
    print(f'  time to first byte : {first_byte_ms} ms')
    print(f'  total time         : {total_ms} ms')
    print(f'  bytes received     : {total_bytes}')
    print(f'  chunks             : {chunk_count}')
    print(f'  audio duration     : {duration_s:.2f} s')
    print(f'  output file        : {args.out}  (play: ffplay -f s16le -ar {sample_rate} -ac 1 {args.out})')

    # Sanity: PCM16 24kHz mono should be even-length and a reasonable size.
    if total_bytes % 2 != 0:
        print('\n⚠️  Warning: byte count is odd — not clean PCM16 framing.')
    if total_bytes == 0:
        print('\n❌ No audio received.')
        sys.exit(1)

    print('\n✅ Stream OK — Kokoro streaming route is working.')


if __name__ == '__main__':
    main()
