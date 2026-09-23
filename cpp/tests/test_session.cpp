#include "../src/session_state.hpp"
#include <fstream>
#include <iostream>
using namespace openaxis;
using namespace openaxis::detail;
bool matches(const Value &got, const Value &expected) {
    if (got.is_number() && expected.is_number())
        return std::abs(got.get<double>() - expected.get<double>()) < 1e-8;
    if (got.is_array() && expected.is_array()) {
        if (got.size() != expected.size())
            return false;
        for (std::size_t i = 0; i < got.size(); ++i)
            if (!matches(got[i], expected[i]))
                return false;
        return true;
    }
    return got == expected;
}
std::optional<Pose> pose(Value v) {
    if (v.is_null())
        return {};
    if (v.is_number())
        v = Value{{"x", v}};
    Pose p;
    p.t = vector_from(v.value("t", Value{v.value("x", 0.), 0, 0}));
    p.r = vector_from(v.value("r", Value{0, 0, 0}));
    p.fov = v.contains("extent") ? 0 : v.value("fov", 1.);
    p.ortho_extent = v.value("extent", 0.);
    return p;
}
int main() try {
    std::ifstream f(std::string(OPENAXIS_FIXTURES) + "/session.json");
    Value fixture;
    f >> fixture;
    for (auto &scenario : fixture["scenarios"]) {
        SessionState s;
        std::map<std::string, Token> tokens;
        std::map<std::string, Accepted> tickets;
        std::map<std::string, std::shared_ptr<Write>> writes;
        int index = 0;
        for (auto &v : scenario["events"]) {
            std::string op = v["op"], name = v.value("as", "last");
            auto token = v.contains("token") ? tokens.at(v["token"]) : s.token();
            auto actual = pose(v.value("actual", Value{}));
            double now = v.value("now", 0.);
            Effect e;
            bool effect = false;
            std::string kind = "ok";
            if (op == "connection")
                s.connection();
            else if (op == "start")
                tokens[name] = s.start(v["gesture"]);
            else if (op == "query")
                kind = s.query(token, actual, v.value("scoped", true), v.value("supplied", true))
                           ? "ok"
                           : "reject";
            else if (op == "receive") {
                auto ticket = s.receive(v.value("epoch", s.epoch), v.value("gesture", s.gesture.value_or(-1)),
                                        v["seq"], *pose(v["pose"]),
                                        v.contains("ack") ? std::optional<std::int64_t>(v["ack"])
                                                          : std::nullopt);
                kind = ticket ? "accepted" : "reject";
                if (ticket)
                    tickets.insert_or_assign(name, *ticket);
            } else if (op == "end")
                kind = s.end(token) ? "ok" : "reject";
            else if (op == "finish")
                kind = s.finish(token) ? "ok" : "reject";
            else {
                effect = true;
                if (op == "process")
                    e = s.process(tickets.at(v.value("ticket", "last")), actual, now);
                else if (op == "observe")
                    e = s.observe(token, actual, now);
                else if (op == "complete")
                    e = s.complete(writes.at(v.value("write", "last")), actual, now,
                                   v.value("success", true));
                else if (op == "cancel")
                    e = s.cancel(token, v["reason"]);
                else if (op == "timeout")
                    e = s.expire(token, v["delta"], now);
                else if (op == "send_failed")
                    e = s.send_failed(token, v["delta"]);
                else
                    throw std::runtime_error("unknown op");
            }
            Value result = {{"kind", effect ? e.kind : kind},
                            {"baseline", s.baseline ? Value(s.baseline->t.x) : Value{}},
                            {"ready", s.ready},
                            {"pending", s.pending ? Value(*s.pending) : Value{}},
                            {"active", s.gesture ? Value(*s.gesture) : Value{}},
                            {"received", s.received},
                            {"applied", s.applied},
                            {"delta_id", e.delta ? Value(*e.delta) : Value{}},
                            {"gesture_id", e.gesture ? Value(*e.gesture) : Value{}},
                            {"reason", e.reason.empty() ? Value{} : Value(e.reason)}};
            if (e.difference) {
                auto d = *e.difference;
                result["t"] = vector_value(d.t);
                result["r"] = vector_value(d.r);
                result["scale"] = std::abs(d.scale - 1) > 1e-7 ? Value(d.scale) : Value{};
            }
            if (e.write)
                writes[name] = e.write;
            for (auto it = v["expect"].begin(); it != v["expect"].end(); ++it) {
                auto got = result.at(it.key());
                if (!matches(got, it.value()))
                    throw std::runtime_error(scenario["name"].get<std::string>() + " event " +
                                             std::to_string(index) + " " + it.key() + " got " +
                                             got.dump() + " expected " + it.value().dump());
            }
            ++index;
        }
    }
    std::cout << fixture["scenarios"].size() << " shared session traces passed\n";
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
