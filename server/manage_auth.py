import argparse
import json
import os
from pathlib import Path

from auth_store import DeviceAuthStore


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.split('#', 1)[0].strip().strip('"').strip("'"))


def get_store() -> DeviceAuthStore:
    load_env_file(Path(__file__).with_name('.env'))
    app_token = os.getenv('APP_TOKEN', '')
    pepper = os.getenv('AUTH_TOKEN_PEPPER') or app_token or 'smartglasses-dev-pepper'
    db_path = os.getenv('AUTH_DB_PATH') or str(Path(__file__).with_name('auth.sqlite3'))
    ttl_days = int(os.getenv('DEVICE_TOKEN_TTL_DAYS', '365'))
    store = DeviceAuthStore(db_path, pepper, ttl_days)
    store.init()
    return store


def main() -> None:
    parser = argparse.ArgumentParser(description='Manage SmartGlasses proxy device auth.')
    sub = parser.add_subparsers(dest='command', required=True)

    create_code = sub.add_parser('create-code', help='Create a one-time pairing code.')
    create_code.add_argument('--name', default='Amalio iPhone')
    create_code.add_argument('--scopes', default='all')
    create_code.add_argument('--ttl', type=int, default=int(os.getenv('PAIRING_CODE_TTL_SECONDS', '900')))

    sub.add_parser('list-devices', help='List registered devices.')

    revoke = sub.add_parser('revoke-device', help='Revoke a registered device.')
    revoke.add_argument('device_id')

    args = parser.parse_args()
    store = get_store()

    if args.command == 'create-code':
        result = store.create_pairing_code(args.name, args.scopes, args.ttl)
        print(json.dumps(result, indent=2))
        return

    if args.command == 'list-devices':
        print(json.dumps(store.list_devices(), indent=2))
        return

    if args.command == 'revoke-device':
        print(json.dumps({'revoked': store.revoke_device(args.device_id)}, indent=2))
        return


if __name__ == '__main__':
    main()
