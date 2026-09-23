#include "verify.hpp"
#include <openaxis/logging.hpp>
#include <algorithm>
#include <chrono>
#include <set>
#include <stdexcept>
#ifdef _WIN32
// clang-format off: BCrypt requires Windows types first.
#include <windows.h>
#include <bcrypt.h>
// clang-format on
#else
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/x509.h>
#endif

namespace openaxis::verification {
Value bundled_roots() {
    // BEGIN BUNDLED ROOTS
    const std::string hex =
        "56786e04d5ce1b9a0d5235712e8fdb514f3dccaaa5f808d43dd209bc0952e5ee"
        "49e26a76dc1ca860436aca88869329e945c8fd25221ca902ba2b4a6d54ba1f37";
    Bytes key;
    for (size_t i = 0; i < hex.size(); i += 2)
        key.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
    return {{"rotatrix-root-1", Value::binary(key)}};
    // END BUNDLED ROOTS
}
class Failure : public std::runtime_error {
public:
    explicit Failure(const char *code) : std::runtime_error(code) {}
};
static void check(bool ok, const char *code = "invalid_proof") {
    if (!ok) throw Failure(code);
}
static Bytes bytes(const Value &v, size_t n) {
    check(v.is_binary() && v.get_binary().size() == n);
    return v.get_binary();
}
static void fields(const Value &v, std::initializer_list<const char *> names) {
    check(v.is_object() && v.size() == names.size());
    for (auto n : names)
        check(v.contains(n));
}
static std::string id(const Value &v) {
    check(v.is_string());
    auto s = v.get<std::string>();
    check(!s.empty() && s.size() <= 128 &&
          std::all_of(s.begin(), s.end(), [](unsigned char c) { return c < 128; }));
    return s;
}
static Bytes raw(const std::string &s) { return Bytes(s.begin(), s.end()); }
static Bytes hash(const Bytes &b) {
    Bytes out(32);
#ifdef _WIN32
    BCRYPT_ALG_HANDLE h = nullptr;
    check(BCryptOpenAlgorithmProvider(&h, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0);
    auto status = BCryptHash(h, nullptr, 0, const_cast<PUCHAR>(b.data()),
                             static_cast<ULONG>(b.size()), out.data(), 32);
    BCryptCloseAlgorithmProvider(h, 0);
    check(status >= 0);
#else
    unsigned int n = 0;
    check(EVP_Digest(b.data(), b.size(), out.data(), &n, EVP_sha256(), nullptr) == 1 && n == 32);
#endif
    return out;
}
Bytes challenge() {
    Bytes b(32);
#ifdef _WIN32
    check(BCryptGenRandom(nullptr, b.data(), 32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0);
#else
    check(RAND_bytes(b.data(), 32) == 1);
#endif
    return b;
}
static void sig(const Bytes &key, const Bytes &data, const Bytes &signature) {
    check(key.size() == 64 && signature.size() == 64);
#ifdef _WIN32
    BCRYPT_ALG_HANDLE alg = nullptr;
    check(BCryptOpenAlgorithmProvider(&alg, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) >= 0);
    Bytes blob(sizeof(BCRYPT_ECCKEY_BLOB) + 64);
    BCRYPT_ECCKEY_BLOB header{BCRYPT_ECDSA_PUBLIC_P256_MAGIC, 32};
    memcpy(blob.data(), &header, sizeof(header));
    std::copy(key.begin(), key.end(), blob.begin() + sizeof(header));
    BCRYPT_KEY_HANDLE k = nullptr;
    auto imported = BCryptImportKeyPair(alg, nullptr, BCRYPT_ECCPUBLIC_BLOB, &k, blob.data(),
                                        static_cast<ULONG>(blob.size()), 0);
    auto digest = hash(data);
    auto status = imported < 0 ? imported
                               : BCryptVerifySignature(k, nullptr, digest.data(), 32,
                                                       const_cast<PUCHAR>(signature.data()), 64, 0);
    if (k)
        BCryptDestroyKey(k);
    BCryptCloseAlgorithmProvider(alg, 0);
    check(status >= 0, "invalid_signature");
#else
    // SubjectPublicKeyInfo for id-ecPublicKey / prime256v1 and uncompressed
    // point.
    Bytes spki = {0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
                  0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
                  0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04};
    spki.insert(spki.end(), key.begin(), key.end());
    const auto *p = spki.data();
    EVP_PKEY *k = d2i_PUBKEY(nullptr, &p, static_cast<long>(spki.size()));
    check(k != nullptr);
    ECDSA_SIG *s = ECDSA_SIG_new();
    check(s != nullptr);
    ECDSA_SIG_set0(s, BN_bin2bn(signature.data(), 32, nullptr),
                   BN_bin2bn(signature.data() + 32, 32, nullptr));
    unsigned char *der = nullptr;
    int len = i2d_ECDSA_SIG(s, &der);
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    bool ok = ctx && EVP_DigestVerifyInit(ctx, nullptr, EVP_sha256(), nullptr, k) == 1 &&
              EVP_DigestVerify(ctx, der, len, data.data(), data.size()) == 1;
    EVP_MD_CTX_free(ctx);
    OPENSSL_free(der);
    ECDSA_SIG_free(s);
    EVP_PKEY_free(k);
    check(ok, "invalid_signature");
#endif
}
static Bytes b64(const Value &v) {
    check(v.is_string());
    auto s = v.get<std::string>();
    check(!s.empty() && s.size() % 4 != 1);
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    Bytes out;
    unsigned bits = 0, acc = 0;
    for (char c : s) {
        auto i = alphabet.find(c);
        check(i != std::string::npos);
        acc = (acc << 6) | static_cast<unsigned>(i);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>(acc >> bits));
        }
    }
    check(bits == 0 || (acc & ((1u << bits) - 1)) == 0);
    return out;
}
static Value json(const Bytes &b) {
    std::vector<std::set<std::string>> keys;
    auto cb = [&](int, Value::parse_event_t e, Value &v) {
        if (e == Value::parse_event_t::object_start)
            keys.emplace_back();
        if (e == Value::parse_event_t::key)
            check(keys.back().insert(v.get<std::string>()).second);
        if (e == Value::parse_event_t::object_end)
            keys.pop_back();
        return true;
    };
    auto v = Value::parse(b.begin(), b.end(), cb);
    check(v.is_object());
    return v;
}
static Bytes pub(const Value &v) {
    fields(v, {"kty", "crv", "x", "y"});
    check(v["kty"] == "EC" && v["crv"] == "P-256");
    auto x = b64(v["x"]), y = b64(v["y"]);
    check(x.size() == 32 && y.size() == 32);
    x.insert(x.end(), y.begin(), y.end());
    return x;
}
static Value cert(const Value &v, const Value &trust, const char *typ) {
    check(v.is_string());
    auto s = v.get<std::string>();
    check(s.size() <= 8192);
    auto a = s.find('.'), b = s.find('.', a + 1);
    check(a != s.npos && b != s.npos && s.find('.', b + 1) == s.npos);
    auto h = json(b64(s.substr(0, a)));
    fields(h, {"alg", "typ", "kid"});
    check(h["alg"] == "ES256" && h["typ"] == typ);
    auto kid = id(h["kid"]);
    check(trust.contains(kid), "untrusted_issuer");
    sig(bytes(trust[kid], 64), raw(s.substr(0, b)), b64(s.substr(b + 1)));
    auto c = json(b64(s.substr(a + 1, b - a - 1)));
    check(c.contains("v") && c["v"].is_number_integer() && c["v"] == 1);
    pub(c.at("key"));
    return c;
}
static double time(const Value &v) {
    check(v.is_number_integer());
    auto n = v.get<double>();
    check(n >= 0 && n <= 9007199254740991.);
    return n;
}
static std::set<std::string> valid(const Value &v, double now) {
    auto n = time(v.at("nbf")), e = time(v.at("exp"));
    check(n < e);
    check(now >= n - 120, "not_yet_valid");
    check(now < e + 120, "expired");
    auto &s = v.at("scopes");
    check(s.is_array() && s.size() <= 16);
    std::set<std::string> out;
    for (auto &x : s)
        check(out.insert(id(x)).second);
    return out;
}
static std::optional<double> verify_impl(const Value &result, const Bytes &nonce, const Value &roots,
                             double now, const char *&stage) {
    if (now < 0)
        now = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
                  .count();
    fields(result, {"token"});
    auto &t = result.at("token");
    fields(t, {"v", "kind", "challenge", "credential", "signature"});
    check(t["v"].is_number_integer() && t["v"] == 1);
    check(nonce.size() == 32 && bytes(t["challenge"], 32) == nonce, "challenge_mismatch");
    auto &c = t["credential"];
    if (t["kind"] == "hardware") {
        stage = "hardware_issuer";
        fields(c, {"key", "ca_signature", "issuer"});
        auto i = cert(c["issuer"], roots, "openaxis-issuer-v1");
        fields(i, {"v", "purpose", "issuer_id", "key"});
        check(i["purpose"] == "hardware-issuer");
        id(i["issuer_id"]);
        auto ca = pub(i["key"]);
        auto device = bytes(c["key"], 64);
        stage = "hardware_credential";
        sig(ca, device, bytes(c["ca_signature"], 64));
        stage = "hardware_signature";
        sig(device, nonce, bytes(t["signature"], 64));
        return {};
    }
    check(t["kind"] == "software");
    fields(c, {"issuer", "license"});
    stage = "software_credential";
    auto i = cert(c["issuer"], roots, "openaxis-issuer-v1");
    check(i["purpose"] == "software-issuer");
    auto allowed = valid(i, now);
    auto l = cert(c["license"], {{id(i["issuer_id"]), Value::binary(pub(i["key"]))}},
                  "openaxis-credential-v1");
    id(l["credential_id"]);
    auto granted = valid(l, now);
    check(granted.count("openaxis.session") &&
          std::includes(allowed.begin(), allowed.end(), granted.begin(), granted.end()) &&
          time(i["nbf"]) <= time(l["nbf"]) && time(l["exp"]) <= time(i["exp"]), "scope_denied");
    const char prefix[] = "OpenAxis software proof v1\0openaxis/1.0\0";
    Bytes data(prefix, prefix + sizeof(prefix) - 1);
    data.insert(data.end(), nonce.begin(), nonce.end());
    for (auto n : {"issuer", "license"}) {
        auto h = hash(raw(c[n].get<std::string>()));
        data.insert(data.end(), h.begin(), h.end());
    }
    stage = "software_signature";
    sig(pub(l["key"]), data, bytes(t["signature"], 64));
    return time(l["exp"]) + 120;
}
std::optional<double> verify(const Value &result, const Bytes &nonce, const Value &roots,
                             double now, const std::function<void(const std::string &)> &report) {
    auto log = [&](const std::string &message) {
        if (report) report(message); else DiagnosticLog::emit("warning", message);
    };
    const char *stage = "envelope";
    try { return verify_impl(result, nonce, roots, now, stage); }
    catch (const Failure &failure) {
        log(std::string("verification.failed stage=") + stage + " reason=" + failure.what());
        throw;
    } catch (...) {
        log(std::string("verification.failed stage=") + stage + " reason=invalid_proof");
        throw Failure("invalid_proof");
    }
}
} // namespace openaxis::verification
