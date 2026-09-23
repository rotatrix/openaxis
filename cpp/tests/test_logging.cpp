#include <openaxis/logging.hpp>
#include <cassert>
#include <iostream>
#include <nlohmann/json.hpp>

int main(int argc, char **argv) {
    if (argc == 4 && std::string(argv[1]) == "--log-probe") {
        openaxis::DiagnosticLog log("interop", argv[2], 100, std::string(argv[3]) == "cleanup" ? 0 : 5);
        if (log.path().empty()) return 2;
        log.write("info", "probe");
        std::cout << log.path().string() << std::endl;
        if (std::string(argv[3]) == "hold") { std::string line; std::getline(std::cin, line); }
        return 0;
    }
    namespace fs = std::filesystem;
    auto root = fs::temp_directory_path() / ("openaxis-log-test-" + std::to_string(
        std::chrono::steady_clock::now().time_since_epoch().count()));
    {
        using Log = openaxis::DiagnosticLog;
        std::ifstream cmakeFile(std::string(OPENAXIS_FIXTURES) + "/../../cpp/CMakeLists.txt");
        std::string cmake((std::istreambuf_iterator<char>(cmakeFile)), {});
        std::smatch version;
        assert(std::regex_search(cmake, version, std::regex("project\\(OpenAxis VERSION ([0-9.]+)")));
        nlohmann::json f; std::ifstream(std::string(OPENAXIS_FIXTURES) + "/logging.json") >> f;
        auto now = std::chrono::system_clock::time_point(std::chrono::milliseconds(f["epoch_ms"].get<long long>()));
        fs::create_directories(root);
        for (int i = 1; i <= 12; ++i) {
            auto name = "retention-20200101T000000Z" + (i == 1 ? std::string() : "-" + std::to_string(i)) + ".log";
            std::ofstream(root / name).put(' ');
        }
        { Log retention("retention", root);
          std::set<std::string> expected, actual;
          for (auto &i : f["retained_suffixes"]) expected.insert("retention-20200101T000000Z-" + std::to_string(i.get<int>()) + ".log");
          for (auto &e : fs::directory_iterator(root)) if (e.path().extension() == ".log" && e.path().filename().string().find("retention-2020") == 0) actual.insert(e.path().filename().string());
          assert(expected == actual);
        }
        { auto r = f["rotation"];
          auto header_bytes = Log::format_record("info", "OpenAxis SDK 1.0.0 (C++); client=boundary; client_version=unknown").size();
          Log boundary("boundary", root, r["max_bytes"].get<std::size_t>() + header_bytes);
          for (int i=0; i<r["writes_before_rotation"].get<int>(); ++i) boundary.write("info", r["message"].get<std::string>());
          assert(fs::file_size(boundary.path()) == r["max_bytes"].get<std::size_t>() + header_bytes);
          assert(!fs::exists(boundary.path().string() + ".1"));
          boundary.write("info", r["message"].get<std::string>());
          assert(fs::file_size(boundary.path().string() + ".1") == r["max_bytes"].get<std::size_t>() + header_bytes);
        }
        Log log("conformance", root);
        { std::ifstream file(log.path()); std::string header; std::getline(file, header);
          assert(header.find("OpenAxis SDK " + version[1].str() + " (C++)") != std::string::npos); }
        int mirrors = 0; log.sink = [&](auto &, auto &) { ++mirrors; };
        std::string expected;
        for (const auto &record : f["records"]) {
            auto level = record["level"].get<std::string>(), message = record["message"].get<std::string>();
            assert(Log::normalize_level(level) == record["normalized"]);
            assert(Log::format_record(level, message, now, f["offset_minutes"].get<int>()) == record["line"]);
            log.write(level, message);
            if (record["normalized"] != "debug") expected += record["line"].get<std::string>();
        }
        std::ifstream input(log.path(), std::ios::binary);
        std::string actual((std::istreambuf_iterator<char>(input)), {}); input.close();
        actual = actual.substr(actual.find('\n') + 1);
        assert(std::regex_replace(actual, std::regex("[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3} [+-][0-9]{2}:[0-9]{2}"), f["stamp"].get<std::string>()) == expected);
        auto count = mirrors; log.close(); log.write("info", "after close"); assert(mirrors == count);
        for (auto &client : f["invalid_clients"]) {
            bool rejected = false;
            try { Log invalid(client.get<std::string>(), root); } catch (const std::invalid_argument &) { rejected = true; }
            assert(rejected);
        }
        std::vector<std::shared_ptr<Log>> configured;
        for (auto &client : f["configuration"]) configured.push_back(Log::configure(client.get<std::string>(), root));
        assert(configured[0] == configured[2] && configured[0] != configured[1]);
        configured[0]->close(); auto fresh = Log::configure("alpha", root); assert(fresh != configured[0]);
        fresh->close(); configured[1]->close();
    }
    {
        openaxis::DiagnosticLog active("test", root, 100);
        assert(!active.path().empty());
        int mirrors = 0;
        active.sink = [&](auto &, auto &) { ++mirrors; };
        active.write("info", std::string(80, 'x'));
        active.write("warning", "new record");
        assert(fs::exists(active.path().string() + ".1"));
        assert(mirrors == 2);
        {
            openaxis::DiagnosticLog other("test", root);
            assert(active.path() != other.path());
        }
        for (int i = 0; i < 12; ++i) { openaxis::DiagnosticLog old("test", root); }
        assert(!fs::exists(active.path()));
        int count = 0;
        for (auto &entry : fs::directory_iterator(root)) if (entry.path().extension() == ".log" && entry.path().filename().string().find("test-") == 0) ++count;
        assert(count == 10);
    }
    {
        openaxis::DiagnosticLog clean("test", root, 100, 0);
        int count = 0;
        for (auto &entry : fs::directory_iterator(root)) if (entry.path().extension() == ".log" && entry.path().filename().string().find("test-") == 0) ++count;
        assert(count == 1);
    }
    {
        openaxis::DiagnosticLog log("header-test", root, 1, 5, "2.3.4");
        log.write("info", "first"); log.write("info", "second");
        for (const auto &path : {log.path(), fs::path(log.path().string() + ".1")}) {
            std::ifstream input(path); std::string header; std::getline(input, header);
            assert(header.find("OpenAxis SDK 1.0.0 (C++); client=header-test; client_version=2.3.4") != std::string::npos);
        }
    }
    fs::remove_all(root);
    std::cout << "Diagnostic log tests passed\n";
}
