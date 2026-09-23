"""Offline credential verification. Trust overrides are internal test seams only."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import re
import time
from dataclasses import dataclass

from ecdsa import NIST256p, VerifyingKey

# Never put fixture roots here or accept roots supplied by a server.
ROOTS: dict[str, bytes] = {
    "rotatrix-root-1": bytes.fromhex(
        "56786e04d5ce1b9a0d5235712e8fdb514f3dccaaa5f808d43dd209bc0952e5ee"
        "49e26a76dc1ca860436aca88869329e945c8fd25221ca902ba2b4a6d54ba1f37"
    ),
}
SKEW = 120
_LOG = logging.getLogger(__name__)


class VerificationError(RuntimeError):
    def __init__(self, code: str = "invalid_proof"):
        self.code = code
        super().__init__(code)


def remote_failure(code, report=None) -> VerificationError:
    reason = code if code in ("unavailable", "busy", "forbidden", "bad_request") else "remote_error"
    (report or _LOG.warning)(f"verification.failed stage=server_response reason={reason}")
    return VerificationError(reason)


@dataclass(frozen=True)
class Verified:
    kind: str
    expires_at: float | None = None


def require(condition: bool, code: str = "invalid_proof") -> None:
    if not condition:
        raise VerificationError(code)


def binary(value, size: int) -> bytes:
    require(type(value) is bytes and len(value) == size)
    return value


def fields(value, names: set[str]) -> None:
    require(type(value) is dict and set(value) == names)


def b64(value: str) -> bytes:
    require(type(value) is str and bool(re.fullmatch(r"[A-Za-z0-9_-]+", value)))
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    require(base64.urlsafe_b64encode(data).decode().rstrip("=") == value)
    return data


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out)
        out[key] = value
    return out


def _json(data):
    def finite(value):
        parsed = float(value)
        require(math.isfinite(parsed))
        return parsed

    return json.loads(
        data.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=lambda _: require(False), parse_float=finite
    )


def identifier(value):
    require(type(value) is str and 0 < len(value) <= 128 and value.isascii())
    return value


def key(value):
    fields(value, {"kty", "crv", "x", "y"})
    require(value["kty"] == "EC" and value["crv"] == "P-256")
    raw = binary(b64(value["x"]), 32) + binary(b64(value["y"]), 32)
    VerifyingKey.from_string(raw, curve=NIST256p)
    return raw


def verify_signature(public: bytes, message: bytes, signature: bytes):
    vk = VerifyingKey.from_string(binary(public, 64), curve=NIST256p)
    try:
        require(vk.verify(binary(signature, 64), message, hashfunc=hashlib.sha256), "invalid_signature")
    except VerificationError:
        raise
    except Exception:
        raise VerificationError("invalid_signature") from None


def certificate(token: str, keys: dict[str, bytes], typ: str):
    require(type(token) is str and len(token) <= 8192 and token.isascii())
    parts = token.split(".")
    require(len(parts) == 3)
    header, payload = _json(b64(parts[0])), _json(b64(parts[1]))
    fields(header, {"alg", "typ", "kid"})
    require(header["alg"] == "ES256" and header["typ"] == typ)
    kid = identifier(header["kid"])
    require(kid in keys, "untrusted_issuer")
    verify_signature(keys[kid], (parts[0] + "." + parts[1]).encode(), b64(parts[2]))
    require(type(payload) is dict and type(payload.get("v")) is int and payload["v"] == 1)
    key(payload["key"])
    return payload


def validity(payload, now):
    nbf, exp = payload["nbf"], payload["exp"]
    require(all(type(t) is int and 0 <= t <= 2**53 - 1 for t in (nbf, exp)))
    require(nbf < exp)
    require(now >= nbf - SKEW, "not_yet_valid")
    require(now < exp + SKEW, "expired")
    scopes = payload["scopes"]
    require(type(scopes) is list and len(scopes) <= 16)
    require(all(identifier(s) for s in scopes))
    require(len(set(scopes)) == len(scopes))
    return set(scopes)


def software_credential(issuer, license, *, roots=None, now=None):
    roots = ROOTS if roots is None else roots
    now = time.time() if now is None else now
    i = certificate(issuer, roots, "openaxis-issuer-v1")
    require(i.get("purpose") == "software-issuer")
    scopes = validity(i, now)
    c = certificate(license, {identifier(i["issuer_id"]): key(i["key"])}, "openaxis-credential-v1")
    identifier(c["credential_id"])
    granted = validity(c, now)
    require(granted <= scopes and "openaxis.session" in granted, "scope_denied")
    require(i["nbf"] <= c["nbf"] and c["exp"] <= i["exp"])
    return key(c["key"]), c["exp"] + SKEW


def transcript(challenge: bytes, issuer: str, license: str):
    return (
        b"OpenAxis software proof v1\0openaxis/1.0\0"
        + binary(challenge, 32)
        + hashlib.sha256(issuer.encode("ascii")).digest()
        + hashlib.sha256(license.encode("ascii")).digest()
    )


def verify(result, challenge: bytes, *, roots=None, now=None, report=None) -> Verified:
    stage = "envelope"
    try:
        fields(result, {"token"})
        t = result["token"]
        fields(t, {"v", "kind", "challenge", "credential", "signature"})
        require(type(t["v"]) is int and t["v"] == 1, "unsupported_credential")
        require(binary(t["challenge"], 32) == binary(challenge, 32), "challenge_mismatch")
        c = t["credential"]
        roots = ROOTS if roots is None else roots
        if t["kind"] == "hardware":
            require(type(c) is dict)
            stage = "hardware_issuer"
            fields(c, {"key", "ca_signature", "issuer"})
            i = certificate(c["issuer"], roots, "openaxis-issuer-v1")
            fields(i, {"v", "purpose", "issuer_id", "key"})
            identifier(i["issuer_id"])
            require(i["purpose"] == "hardware-issuer")
            ca = key(i["key"])
            device = binary(c["key"], 64)
            stage = "hardware_credential"
            verify_signature(ca, device, c["ca_signature"])
            stage = "hardware_signature"
            verify_signature(device, challenge, t["signature"])
            return Verified("hardware")
        require(t["kind"] == "software", "unsupported_credential")
        fields(c, {"issuer", "license"})
        stage = "software_credential"
        public, expiry = software_credential(c["issuer"], c["license"], roots=roots, now=now)
        stage = "software_signature"
        verify_signature(public, transcript(challenge, c["issuer"], c["license"]), t["signature"])
        return Verified("software", expiry)
    except Exception as error:
        code = error.code if isinstance(error, VerificationError) else "invalid_proof"
        (report or _LOG.warning)(f"verification.failed stage={stage} reason={code}")
        raise VerificationError(code) from None
