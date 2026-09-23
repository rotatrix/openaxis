#pragma once
#include <memory>
#include <openaxis/diagnostics.hpp>
namespace openaxis::detail {
struct Token {
    unsigned epoch = 0, generation = 0;
    bool operator==(Token b) const { return epoch == b.epoch && generation == b.generation; }
};
struct Accepted {
    Token token;
    Pose pose;
    std::int64_t seq;
    std::optional<std::int64_t> ack;
};
struct Write {
    Accepted accepted;
};
struct Effect {
    std::string kind = "reject";
    Token token{};
    std::optional<std::int64_t> gesture{}, delta{};
    std::optional<PoseDifference> difference{};
    std::shared_ptr<Write> write{};
    std::string reason{};
    std::optional<Pose> pose{};
};
class SessionState {
    std::int64_t consumed = -1;
    std::optional<Pose> requested;
    std::shared_ptr<Write> writing;
    std::function<PoseDifference(const Pose &, const Pose &)> compare;
    double timeout;
    std::string stream;
    void retire() {
        ++generation;
        gesture.reset();
        ready = ending = false;
        baseline.reset();
        requested.reset();
        pending.reset();
        deadline.reset();
    }
    Effect delta(const Pose &actual, PoseDifference d, double now) {
        if (next_delta > 9007199254740991LL)
            return cancel(token(), stream + "_delta_id_exhausted");
        pending = next_delta++;
        deadline = now + timeout;
        baseline = actual;
        requested.reset();
        Effect e{"delta", token(), gesture, pending};
        e.difference = d;
        return e;
    }
    Effect rebase(const Pose &actual, double now) {
        if (ending)
            return {"hold"};
        auto e = delta(actual, {}, now);
        if (e.kind != "cancel") {
            e.kind = "rebase";
            e.pose = actual;
        }
        return e;
    }

  public:
    unsigned epoch = 0, generation = 0;
    std::optional<std::int64_t> gesture, pending;
    std::int64_t received = -1, applied = -1, next_delta = 0;
    std::optional<Pose> baseline;
    std::optional<double> deadline;
    bool ready = false, ending = false;
    SessionState(std::string name = "camera", double seconds = 1,
                 std::function<PoseDifference(const Pose &, const Pose &)> comparison = {})
        : compare(std::move(comparison)), timeout(seconds), stream(std::move(name)) {
        if (!std::isfinite(timeout) || timeout <= 0)
            throw std::invalid_argument("invalid timeout");
        if (!compare)
            compare = [this](const Pose &a, const Pose &b) {
                return stream == "object" ? compare_object_poses(a, b) : compare_poses(a, b);
            };
    }
    Token token() const { return {epoch, generation}; }
    bool current(Token t) const { return t == token() && gesture.has_value(); }
    void connection() {
        retire();
        ++epoch;
        received = applied = consumed = -1;
        next_delta = 0;
    }
    Token start(std::int64_t id) {
        retire();
        gesture = id;
        return token();
    }
    bool end(Token t) {
        if (!current(t))
            return false;
        ending = true;
        return true;
    }
    bool finish(Token t) {
        if (!current(t))
            return false;
        retire();
        return true;
    }
    bool query(Token t, std::optional<Pose> actual, bool scoped = true, bool supplied = true,
               bool allow_ending = false) {
        if (!scoped || !supplied || !current(t) || (ending && !allow_ending) || writing)
            return false;
        if (!ready) {
            ready = true;
            baseline = actual;
        }
        return true;
    }
    std::optional<Accepted> receive(unsigned ep, std::int64_t id, std::int64_t seq, Pose pose,
                                    std::optional<std::int64_t> ack = {}) {
        if (ep != epoch || !gesture || id != *gesture || ending || seq <= received)
            return {};
        received = seq;
        return Accepted{token(), pose, seq, ack};
    }
    Effect cancel(Token t, std::string reason) {
        if (!current(t))
            return {};
        Effect e{"cancel", t, gesture};
        e.reason = std::move(reason);
        retire();
        return e;
    }
    Effect expire(Token t, std::int64_t id, double now) {
        return current(t) && pending == id && deadline && now >= *deadline
                   ? cancel(t, stream + "_delta_timeout")
                   : Effect{};
    }
    Effect send_failed(Token t, std::int64_t id) {
        return current(t) && pending == id ? cancel(t, stream + "_delta_send_failed") : Effect{};
    }
    Effect observe(Token t, std::optional<Pose> actual, double now) {
        if (!current(t) || !ready)
            return {};
        if (writing)
            return {"hold"};
        if (!actual)
            return {"skip"};
        auto reference = baseline ? baseline : requested;
        if (!reference) {
            baseline = actual;
            return {"skip"};
        }
        auto d = compare(*reference, *actual);
        if (d.rebase)
            return rebase(*actual, now);
        if (!d.changed) {
            if (!baseline) {
                baseline = actual;
                requested.reset();
            }
            return {"skip"};
        }
        if (pending || ending)
            return {"hold"};
        return delta(*actual, d, now);
    }
    Effect process(Accepted accepted, std::optional<Pose> actual, double now) {
        if (!current(accepted.token) || !ready || accepted.seq != received ||
            accepted.seq <= consumed)
            return {};
        if (writing)
            return {"hold"};
        if (pending && accepted.ack && *accepted.ack >= *pending) {
            pending.reset();
            deadline.reset();
        }
        auto e = observe(accepted.token, actual, now);
        if (e.kind != "skip")
            return e;
        if (pending)
            return {"hold"};
        auto realized = actual ? actual : baseline;
        if (realized) {
            auto d = compare(*realized, accepted.pose);
            if (!d.changed && !d.rebase) {
                consumed = accepted.seq;
                return {"skip"};
            }
        }
        writing = std::make_shared<Write>(Write{accepted});
        e = {"apply", token(), gesture};
        e.write = writing;
        return e;
    }
    Effect complete(std::shared_ptr<Write> write, std::optional<Pose> actual, double now,
                    bool success = true) {
        if (writing != write)
            return {};
        writing.reset();
        if (!current(write->accepted.token))
            return {};
        if (!success)
            return cancel(write->accepted.token, stream + "_write_failed");
        applied = consumed = write->accepted.seq;
        baseline = actual;
        requested = actual ? std::optional<Pose>{} : write->accepted.pose;
        if (actual && !ending) {
            auto d = compare(write->accepted.pose, *actual);
            if (d.rebase)
                return rebase(*actual, now);
            if (d.changed)
                return delta(*actual, d, now);
        }
        return {"skip"};
    }
};
} // namespace openaxis::detail
