import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from typing import Any


def normalize_pairing_code(code: str) -> str:
    return ''.join(ch for ch in code.upper() if ch.isalnum())


class DeviceAuthStore:
    def __init__(self, db_path: str, pepper: str, token_ttl_days: int = 365):
        self.db_path = db_path
        self.pepper = pepper
        self.token_ttl_days = token_ttl_days

    def connect(self) -> sqlite3.Connection:
        directory = os.path.dirname(os.path.abspath(self.db_path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    scopes TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    last_seen_at INTEGER,
                    revoked_at INTEGER,
                    user_agent TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS pairing_codes (
                    code_hash TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    scopes TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used_at INTEGER
                )
                """
            )
            conn.execute('CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_pairing_expires_at ON pairing_codes(expires_at)')

    def hash_secret(self, secret: str) -> str:
        return hmac.new(self.pepper.encode('utf-8'), secret.encode('utf-8'), hashlib.sha256).hexdigest()

    def create_pairing_code(self, name: str, scopes: str = 'all', ttl_seconds: int = 900) -> dict[str, Any]:
        alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        code = 'SG-' + ''.join(secrets.choice(alphabet) for _ in range(6))
        now = int(time.time())
        expires_at = now + ttl_seconds
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO pairing_codes (code_hash, name, scopes, created_at, expires_at, used_at)
                VALUES (?, ?, ?, ?, ?, NULL)
                """,
                (self.hash_secret(normalize_pairing_code(code)), name[:80], scopes, now, expires_at),
            )
        return {
            'code': code,
            'name': name[:80],
            'scopes': self.parse_scopes(scopes),
            'expires_at': expires_at,
        }

    def redeem_pairing_code(self, code: str, device_name: str, user_agent: str = '') -> tuple[dict[str, Any] | None, str | None]:
        normalized = normalize_pairing_code(code)
        if not normalized:
            return None, 'missing_code'

        code_hash = self.hash_secret(normalized)
        now = int(time.time())
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT code_hash, name, scopes, expires_at, used_at
                FROM pairing_codes
                WHERE code_hash = ?
                """,
                (code_hash,),
            ).fetchone()
            if not row:
                return None, 'invalid_code'
            if row['used_at'] is not None:
                return None, 'code_used'
            if int(row['expires_at']) < now:
                return None, 'code_expired'

            token = f'sgdt_{secrets.token_urlsafe(32)}'
            device_id = f'dev_{secrets.token_hex(8)}'
            expires_at = now + self.token_ttl_days * 86400
            name = (device_name or row['name'] or 'iPhone')[:80]
            scopes = row['scopes'] or 'all'
            conn.execute(
                """
                INSERT INTO devices (id, name, token_hash, scopes, created_at, expires_at, last_seen_at, revoked_at, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
                """,
                (device_id, name, self.hash_secret(token), scopes, now, expires_at, now, user_agent[:200]),
            )
            conn.execute(
                'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?',
                (now, code_hash),
            )

        return {
            'token': token,
            'device_id': device_id,
            'device_name': name,
            'scopes': self.parse_scopes(scopes),
            'expires_at': expires_at,
        }, None

    def authenticate(self, token: str, required_scope: str = 'chat') -> tuple[dict[str, Any] | None, str | None]:
        if not token:
            return None, 'missing_token'

        now = int(time.time())
        token_hash = self.hash_secret(token)
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT id, name, scopes, expires_at, last_seen_at, revoked_at
                FROM devices
                WHERE token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if not row:
                return None, 'invalid_token'
            if row['revoked_at'] is not None:
                return None, 'revoked_token'
            if int(row['expires_at']) < now:
                return None, 'expired_token'

            scopes = self.parse_scopes(row['scopes'])
            if not self.has_scope(scopes, required_scope):
                return None, 'insufficient_scope'

            conn.execute('UPDATE devices SET last_seen_at = ? WHERE id = ?', (now, row['id']))

        return {
            'id': row['id'],
            'name': row['name'],
            'scopes': scopes,
            'expires_at': int(row['expires_at']),
            'last_seen_at': row['last_seen_at'],
        }, None

    def revoke_device(self, device_id: str) -> bool:
        now = int(time.time())
        with self.connect() as conn:
            cursor = conn.execute(
                'UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
                (now, device_id),
            )
            return cursor.rowcount > 0

    def list_devices(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, scopes, created_at, expires_at, last_seen_at, revoked_at, user_agent
                FROM devices
                ORDER BY created_at DESC
                """
            ).fetchall()
        return [
            {
                'id': row['id'],
                'name': row['name'],
                'scopes': self.parse_scopes(row['scopes']),
                'created_at': row['created_at'],
                'expires_at': row['expires_at'],
                'last_seen_at': row['last_seen_at'],
                'revoked_at': row['revoked_at'],
                'user_agent': row['user_agent'],
            }
            for row in rows
        ]

    @staticmethod
    def parse_scopes(scopes: str) -> list[str]:
        values = [scope.strip() for scope in scopes.split(',') if scope.strip()]
        return values or ['all']

    @staticmethod
    def has_scope(scopes: list[str], required_scope: str) -> bool:
        return 'all' in scopes or required_scope in scopes
