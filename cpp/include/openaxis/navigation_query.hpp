#pragma once
#include "messages.hpp"
#include <functional>
#include <memory>

namespace openaxis {
// Copies share completion ownership. Retain a query by value for deferred work;
// evaluate and complete it on the client's application thread. nullptr facts are
// unavailable; evaluate_query strips local pick marker metadata before sending.
class NavigationQuery {
    struct State {
        Request request;
        std::function<bool(const Value &)> send;
        bool completed = false;
    };
    std::shared_ptr<State> state_;
  public:
    NavigationQuery(Request request, std::function<bool(const Value &)> send)
        : state_(std::make_shared<State>(State{std::move(request), std::move(send)})) {
        validate_message(message_value(state_->request));
        if (state_->request.method != "navigation.query" || !state_->send)
            throw std::invalid_argument("NavigationQuery requires a navigation.query request and sender");
        for (const char *key : {"values", "first"})
            for (const auto &name : state_->request.params.value(key, Value::array()))
                if (!name.is_string() || name.get<std::string>().empty())
                    throw std::invalid_argument("query names must be non-empty strings");
    }
    const Request &request() const { return state_->request; }
    std::int64_t request_id() const { return state_->request.id; }
    std::optional<std::int64_t> gesture_id() const {
        const auto &p = state_->request.params;
        return p.contains("gesture_id") ? std::optional<std::int64_t>(integer(p["gesture_id"])) : std::nullopt;
    }
    bool scoped() const { return gesture_id().has_value(); }
    bool has_first() const { return state_->request.params.contains("first"); }
    std::vector<std::string> values() const { return state_->request.params.value("values", std::vector<std::string>{}); }
    std::vector<std::string> first() const { return state_->request.params.value("first", std::vector<std::string>{}); }
    bool completed() const { return state_->completed; }
    template <class Resolver> Value evaluate(Resolver resolve) const {
        return evaluate_query(state_->request.params, std::move(resolve));
    }
    void claim() {
        if (state_->completed) throw std::logic_error("NavigationQuery has already been completed");
        state_->completed = true;
    }
    bool complete(Value result) {
        if (!result.is_object()) throw std::invalid_argument("query result must be a map");
        claim();
        return state_->send({{"type", "response"}, {"id", request_id()}, {"result", std::move(result)}});
    }
    bool fail(std::string code, std::optional<std::string> message = {}) {
        if (code.find_first_not_of(" \t\r\n") == std::string::npos) throw std::invalid_argument("error code is required");
        Value error = {{"code", std::move(code)}};
        if (message) error["message"] = *message;
        claim();
        return state_->send({{"type", "response"}, {"id", request_id()}, {"error", std::move(error)}});
    }
};
} // namespace openaxis
