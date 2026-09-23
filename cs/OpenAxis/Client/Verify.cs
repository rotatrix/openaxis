using System;
using OpenAxis.Diagnostics;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Security.Cryptography;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Org.BouncyCastle.Asn1.Sec;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Math;

namespace OpenAxis.Client
{
    public sealed class VerificationException : Exception
    {
        public string Code { get; }
        internal VerificationException(string code = "invalid_proof") : base(code) { Code = code; }
    }

    internal static class Verification
    {
        internal static VerificationException RemoteFailure(string code, Action<string>? report = null)
        {
            var reason = code == "unavailable" || code == "busy" || code == "forbidden" || code == "bad_request" ? code : "remote_error";
            (report ?? (message => DiagnosticLog.Emit("warning", message)))($"verification.failed stage=server_response reason={reason}");
            return new VerificationException(reason);
        }

        internal static readonly Dictionary<string, byte[]> Roots = new()
        {
            ["rotatrix-root-1"] = Hex(
                "56786e04d5ce1b9a0d5235712e8fdb514f3dccaaa5f808d43dd209bc0952e5ee" +
                "49e26a76dc1ca860436aca88869329e945c8fd25221ca902ba2b4a6d54ba1f37")
        };
        internal static byte[] Hex(string s) => Enumerable.Range(0, s.Length / 2).Select(i => Convert.ToByte(s.Substring(i * 2, 2), 16)).ToArray();
        static void Check(bool ok, string code = "invalid_proof") { if (!ok) throw new VerificationException(code); }
        static Dictionary<string, object> Map(object x) => MsgUtil.ToMap(x, "credential");
        static void Fields(Dictionary<string, object> d, params string[] names) => Check(d.Keys.OrderBy(x => x).SequenceEqual(names.OrderBy(x => x)));
        static byte[] Bytes(object x, int length) { Check(x is byte[] b && b.Length == length); return (byte[])x; }
        static string Id(object x) { Check(x is string s && s.Length > 0 && s.Length <= 128 && s.All(c => c < 128)); return (string)x; }
        static string JId(JToken? x) { Check(x?.Type == JTokenType.String); return Id((string)x!); }
        static byte[] B64(string s)
        {
            Check(s.Length > 0 && s.All(c => char.IsLetterOrDigit(c) && c < 128 || c == '-' || c == '_'));
            var b = Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/') + new string('=', (4 - s.Length % 4) % 4));
            Check(Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_') == s); return b;
        }
        static JObject Json(byte[] b)
        {
            var s = new UTF8Encoding(false, true).GetString(b);
            var structure = System.Text.RegularExpressions.Regex.Replace(s, "\"(?:\\\\.|[^\"\\\\])*\"", "\"\"");
            Check(!System.Text.RegularExpressions.Regex.IsMatch(structure, ",\\s*[}\\]]"));
            // Json.NET accepts comments/nonfinite constants; reject these before parsing.
            using var r = new JsonTextReader(new System.IO.StringReader(s)) { DateParseHandling = DateParseHandling.None, MaxDepth = 32 };
            while (r.Read())
            {
                Check(r.TokenType != JsonToken.Comment && r.TokenType != JsonToken.Undefined && !(r.Value is double n && (double.IsNaN(n) || double.IsInfinity(n))));
                if (r.TokenType == JsonToken.String || r.TokenType == JsonToken.PropertyName) Check(r.QuoteChar == '"');
            }
            return JObject.Parse(s, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
        }
        static byte[] Public(JToken j)
        {
            Check(j is JObject o && o.Properties().Select(p => p.Name).OrderBy(x => x).SequenceEqual(new[] { "crv", "kty", "x", "y" }));
            Check((string?)j["kty"] == "EC" && (string?)j["crv"] == "P-256");
            var b = Bytes(B64((string)j["x"]!), 32).Concat(Bytes(B64((string)j["y"]!), 32)).ToArray(); Decode(b); return b;
        }
        static ECPublicKeyParameters Decode(byte[] b)
        {
            Bytes(b, 64); var c = SecNamedCurves.GetByName("secp256r1");
            return new ECPublicKeyParameters(c.Curve.DecodePoint(new byte[] { 4 }.Concat(b).ToArray()), new ECDomainParameters(c.Curve, c.G, c.N, c.H));
        }
        static byte[] Hash(byte[] b) { using var sha = SHA256.Create(); return sha.ComputeHash(b); }
        static void Sig(byte[] key, byte[] data, object signature)
        {
            var s = Bytes(signature, 64); var v = new ECDsaSigner(); v.Init(false, Decode(key));
            Check(v.VerifySignature(Hash(data), new BigInteger(1, s, 0, 32), new BigInteger(1, s, 32, 32)), "invalid_signature");
        }
        static JObject Cert(object value, Dictionary<string, byte[]> trust, string typ)
        {
            Check(value is string text && text.Length <= 8192 && text.All(c => c < 128)); var p = ((string)value).Split('.'); Check(p.Length == 3);
            var h = Json(B64(p[0])); Check(h.Properties().Select(x => x.Name).OrderBy(x => x).SequenceEqual(new[] { "alg", "kid", "typ" }));
            Check((string?)h["alg"] == "ES256" && (string?)h["typ"] == typ);
            var kid = JId(h["kid"]); Check(trust.ContainsKey(kid), "untrusted_issuer"); Sig(trust[kid], Encoding.ASCII.GetBytes(p[0] + "." + p[1]), B64(p[2]));
            var c = Json(B64(p[1])); Check(c["v"]?.Type == JTokenType.Integer && (long)c["v"]! == 1); Public(c["key"]!); return c;
        }
        static long Time(JToken? t) { Check(t?.Type == JTokenType.Integer); var n = (long)t!; Check(n >= 0 && n <= 9007199254740991L); return n; }
        static HashSet<string> Valid(JObject c, double now)
        {
            var n = Time(c["nbf"]); var e = Time(c["exp"]); Check(n < e); Check(now >= n - 120, "not_yet_valid"); Check(now < e + 120, "expired");
            Check(c["scopes"] is JArray a && a.Count <= 16); var scopes = ((JArray)c["scopes"]!).Select(s => { Check(s.Type == JTokenType.String); return Id((string)s!); }).ToArray();
            var set = new HashSet<string>(scopes); Check(set.Count == scopes.Length); return set;
        }
        // Internal trust arguments allow synthetic tests without a shipped trust switch.
        internal static double? Verify(Dictionary<string, object> result, byte[] challenge, Dictionary<string, byte[]>? roots = null, double? now = null, Action<string>? report = null)
        {
            var stage = "envelope";
            try
            {
                Fields(result, "token"); var t = Map(result["token"]); Fields(t, "v", "kind", "challenge", "credential", "signature");
                Check(t["v"] is byte or sbyte or short or ushort or int or uint or long or ulong, "unsupported_credential");
                Check(Convert.ToDecimal(t["v"]) == 1, "unsupported_credential");
                Check(Bytes(t["challenge"], 32).SequenceEqual(Bytes(challenge, 32)), "challenge_mismatch"); var c = Map(t["credential"]);
                if ((string)t["kind"] == "hardware")
                {
                    stage = "hardware_issuer";
                    Fields(c, "key", "ca_signature", "issuer");
                    var i = Cert(c["issuer"], roots ?? Roots, "openaxis-issuer-v1");
                    Check(i.Properties().Select(p => p.Name).OrderBy(x => x).SequenceEqual(new[] { "issuer_id", "key", "purpose", "v" }));
                    Check((string?)i["purpose"] == "hardware-issuer"); JId(i["issuer_id"]); var ca = Public(i["key"]!);
                    stage = "hardware_credential"; var device = Bytes(c["key"], 64); Sig(ca, device, c["ca_signature"]); stage = "hardware_signature"; Sig(device, challenge, t["signature"]); return null;
                }
                Check((string)t["kind"] == "software", "unsupported_credential"); Fields(c, "issuer", "license");
                stage = "software_credential";
                var issuer = Cert(c["issuer"], roots ?? Roots, "openaxis-issuer-v1"); Check((string?)issuer["purpose"] == "software-issuer");
                var clock = now ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds(); var allowed = Valid(issuer, clock);
                var license = Cert(c["license"], new Dictionary<string, byte[]> { { JId(issuer["issuer_id"]), Public(issuer["key"]!) } }, "openaxis-credential-v1");
                JId(license["credential_id"]); var granted = Valid(license, clock); Check(granted.Contains("openaxis.session") && granted.IsSubsetOf(allowed), "scope_denied");
                Check(Time(issuer["nbf"]) <= Time(license["nbf"]) && Time(license["exp"]) <= Time(issuer["exp"]));
                var data = Encoding.ASCII.GetBytes("OpenAxis software proof v1\0openaxis/1.0\0").Concat(challenge).Concat(Hash(Encoding.ASCII.GetBytes((string)c["issuer"]))).Concat(Hash(Encoding.ASCII.GetBytes((string)c["license"]))).ToArray();
                stage = "software_signature";
                Sig(Public(license["key"]!), data, t["signature"]); return Time(license["exp"]) + 120;
            }
            catch (Exception error)
            {
                var code = error is VerificationException failure ? failure.Code : "invalid_proof";
                (report ?? (message => DiagnosticLog.Emit("warning", message)))($"verification.failed stage={stage} reason={code}");
                throw new VerificationException(code);
            }
        }
    }
}
