// Test-only boundary stub. Never linked into the distributable SDK.
#include "../src/verify.hpp"
namespace openaxis::verification {
Bytes challenge() { return Bytes(32); }
Value bundled_roots() { return Value::object(); }
std::optional<double> verify(const Value &, const Bytes &, const Value &, double, const std::function<void(const std::string &)> &) {
    return std::nullopt;
}
}
