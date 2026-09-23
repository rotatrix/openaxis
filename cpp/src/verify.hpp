#pragma once
#include <openaxis/protocol.hpp>
#include <optional>
#include <functional>
namespace openaxis::verification {
using Bytes = std::vector<std::uint8_t>;
Bytes challenge();
Value bundled_roots();
// Internal trust arguments for conformance fixtures, not OpenAxisClientOptions.
std::optional<double> verify(const Value &result, const Bytes &nonce,
                             const Value &roots = bundled_roots(),
                             double now = -1,
                             const std::function<void(const std::string &)> &report = {});
} // namespace openaxis::verification
