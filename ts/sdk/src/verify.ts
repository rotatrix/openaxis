import { emitDiagnosticLog } from "./logging.js";
/** Internal offline verifier. Production roots are populated only by provisioning. */
export const roots: Record<string, Uint8Array> = {
    "rotatrix-root-1": Uint8Array.from(
        ("56786e04d5ce1b9a0d5235712e8fdb514f3dccaaa5f808d43dd209bc0952e5ee" +
         "49e26a76dc1ca860436aca88869329e945c8fd25221ca902ba2b4a6d54ba1f37").match(/../g)!,
        x => parseInt(x, 16),
    ),
};
const utf8 = new TextEncoder();
export class VerificationError extends Error {
    constructor(readonly code = "invalid_proof") { super(code); this.name = "VerificationError"; }
}
function check(ok: unknown, code = "invalid_proof"): asserts ok { if (!ok)
    throw new VerificationError(code); }
function bytes(x: unknown, n: number): Uint8Array { check(x instanceof Uint8Array && x.length === n); return x; }
function map(x: unknown): Record<string, any> { check(x !== null && typeof x === "object" && !Array.isArray(x) && !(x instanceof Uint8Array)); return x as Record<string, any>; }
function fields(x: unknown, names: string[]): Record<string, any> {
    const o = map(x);
    check(Object.keys(o).sort().join("|") === names.sort().join("|"));
    return o;
}
function id(x: unknown): string { check(typeof x === "string" && /^[\x00-\x7f]{1,128}$/.test(x)); return x; }
function b64(x: unknown): Uint8Array {
    check(typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x));
    const b = Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    check(btoa(String.fromCharCode(...b)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") === x);
    return b;
}
function json(b: Uint8Array): Record<string, any> {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(b);
    const value = JSON.parse(text);
    const finite = (v: unknown): void => { if (typeof v === "number")
        check(Number.isFinite(v));
    else if (v && typeof v === "object")
        Object.values(v).forEach(finite); };
    finite(value);
    // Scan object keys at every depth; JSON.parse alone silently accepts duplicates.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)!;
    const stack: {
        keys?: Set<string>;
        key: boolean;
    }[] = [];
    for (const t of tokens) {
        const top = stack[stack.length - 1];
        if (t === "{")
            stack.push({ keys: new Set(), key: true });
        else if (t === "[")
            stack.push({ key: false });
        else if (t === "}" || t === "]")
            stack.pop();
        else if (t === "," && top?.keys)
            top.key = true;
        else if (top?.keys && top.key) {
            const k = JSON.parse(t);
            check(!top.keys.has(k));
            top.keys.add(k);
            top.key = false;
        }
    }
    return map(value);
}
function pub(x: unknown): Uint8Array {
    const k = fields(x, ["kty", "crv", "x", "y"]);
    check(k.kty === "EC" && k.crv === "P-256");
    return concat(bytes(b64(k.x), 32), bytes(b64(k.y), 32));
}
function concat(...parts: Uint8Array[]) { const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) {
    b.set(p, i);
    i += p.length;
} return b; }
async function sig(key: Uint8Array, data: Uint8Array, signature: unknown) {
    const k = await crypto.subtle.importKey("raw", concat(new Uint8Array([4]), bytes(key, 64)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    check(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, new Uint8Array(bytes(signature, 64)), new Uint8Array(data)), "invalid_signature");
}
async function cert(token: unknown, trust: Record<string, Uint8Array>, typ: string) {
    check(typeof token === "string" && token.length <= 8192 && /^[\x00-\x7f]*$/.test(token));
    const p = token.split(".");
    check(p.length === 3);
    const h = fields(json(b64(p[0])), ["alg", "typ", "kid"]);
    check(h.alg === "ES256" && h.typ === typ);
    const k = trust[id(h.kid)];
    check(k, "untrusted_issuer");
    await sig(k, utf8.encode(p[0] + "." + p[1]), b64(p[2]));
    const c = json(b64(p[1]));
    check(c.v === 1);
    pub(c.key);
    return c;
}
function valid(c: Record<string, any>, now: number): Set<string> {
    check(Number.isSafeInteger(c.nbf) && Number.isSafeInteger(c.exp) && c.nbf >= 0 && c.nbf < c.exp);
    check(now >= c.nbf - 120, "not_yet_valid");
    check(now < c.exp + 120, "expired");
    check(Array.isArray(c.scopes) && c.scopes.length <= 16);
    c.scopes.forEach(id);
    const scopes = new Set<string>(c.scopes);
    check(scopes.size === c.scopes.length);
    return scopes;
}
export async function verify(result: unknown, challenge: Uint8Array, trust = roots, now = Date.now() / 1000, report = (message: string) => emitDiagnosticLog("warning", message)): Promise<{
    kind: string;
    expiresAt?: number;
}> {
    let stage = "envelope";
    try {
        const t = fields(fields(result, ["token"]).token, ["v", "kind", "challenge", "credential", "signature"]);
        check(t.v === 1, "unsupported_credential");
        check(bytes(t.challenge, 32).every((v, i) => v === bytes(challenge, 32)[i]), "challenge_mismatch");
        const c = map(t.credential);
        if (t.kind === "hardware") {
            stage = "hardware_issuer";
            fields(c, ["key", "ca_signature", "issuer"]);
            const i = await cert(c.issuer, trust, "openaxis-issuer-v1");
            fields(i, ["v", "purpose", "issuer_id", "key"]);
            check(i.purpose === "hardware-issuer");
            id(i.issuer_id);
            const ca = pub(i.key);
            stage = "hardware_credential";
            await sig(ca, bytes(c.key, 64), c.ca_signature);
            stage = "hardware_signature";
            await sig(c.key, challenge, t.signature);
            return { kind: "hardware" };
        }
        check(t.kind === "software", "unsupported_credential");
        fields(c, ["issuer", "license"]);
        stage = "software_credential";
        const i = await cert(c.issuer, trust, "openaxis-issuer-v1");
        check(i.purpose === "software-issuer");
        const allowed = valid(i, now);
        const l = await cert(c.license, { [id(i.issuer_id)]: pub(i.key) }, "openaxis-credential-v1");
        id(l.credential_id);
        const granted = valid(l, now);
        check(granted.has("openaxis.session") && [...granted].every(s => allowed.has(s)) && i.nbf <= l.nbf && l.exp <= i.exp, "scope_denied");
        const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(s)));
        stage = "software_signature";
        await sig(pub(l.key), concat(utf8.encode("OpenAxis software proof v1\0openaxis/1.0\0"), challenge, await hash(c.issuer), await hash(c.license)), t.signature);
        return { kind: "software", expiresAt: l.exp + 120 };
    }
    catch (e) {
        const code = e instanceof VerificationError ? e.code : "invalid_proof";
        report(`verification.failed stage=${stage} reason=${code}`);
        throw new VerificationError(code);
    }
}
export function nativeRuntime(): boolean {
    const g = globalThis as typeof globalThis & {
        process?: {
            versions?: {
                node?: string;
            };
        };
    };
    if (g.process?.versions?.node)
        return true;
    if (typeof navigator !== "undefined" && (typeof window !== "undefined" || typeof self !== "undefined"))
        return false;
    throw new VerificationError("unsupported_runtime");
}

export function remoteFailure(code: string, report = (message: string) => emitDiagnosticLog("warning", message)): VerificationError {
    const reason = ["unavailable", "busy", "forbidden", "bad_request"].includes(code) ? code : "remote_error";
    report(`verification.failed stage=server_response reason=${reason}`);
    return new VerificationError(reason);
}
