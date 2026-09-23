#include "integration.hpp"
#include "application.hpp"
#include "diagnostic_view.hpp"
#include "glfw_scheduler.hpp"
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#include <GLFW/glfw3.h>
#include <backends/imgui_impl_glfw.h>
#include <backends/imgui_impl_opengl2.h>
#include <filesystem>
#include <fstream>
#include <imgui.h>
#include <iomanip>
#include <iostream>
#include <openaxis/navigation.hpp>
#include <openaxis/connection_manager.hpp>
#include <openaxis/logging.hpp>
#include <sstream>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif
using namespace openaxis;
struct Input {
    MyApplication *app;
    int button = -1, last_clicked = -1;
    double x = 0, y = 0, start_x = 0, start_y = 0, last_click = 0, last_click_x = 0,
           last_click_y = 0;
    bool dragged = false;
};
int main(int argc, char **argv) try {
#ifdef _WIN32
    // SDK diagnostic text is UTF-8, including when redirected to a log file.
    SetConsoleOutputCP(CP_UTF8);
#endif
    bool debug = false;
    std::string url = "ws://127.0.0.1:6607";
    for (int i = 1; i < argc;) {
        if (std::string(argv[i]) == "--url") {
            if (i + 1 >= argc)
                throw std::runtime_error("--url requires a WebSocket URL");
            url = argv[i + 1];
            for (int j = i; j < argc - 2; ++j)
                argv[j] = argv[j + 2];
            argc -= 2;
        } else if (std::string(argv[i]) == "--debug") {
            debug = true;
            for (int j = i; j < argc - 1; ++j)
                argv[j] = argv[j + 1];
            --argc;
        } else
            ++i;
    }
    std::string mode = argc > 1 ? argv[1] : "";
    bool diagnostic_smoke = mode == "--smoke-diagnostics" || mode == "--smoke-diagnostics-ortho";
    bool smoke = mode == "--smoke" || diagnostic_smoke;
    auto path = argc > 1 && !smoke
                    ? std::filesystem::path(argv[1])
                    : std::filesystem::absolute(argv[0]).parent_path() / "scene.json";
    MyApplication app(path.string());
    if (!glfwInit())
        throw std::runtime_error("GLFW initialization failed");
    if (smoke)
        glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
    auto *window = glfwCreateWindow(1200, 800, "demo 3D app - C++", nullptr, nullptr);
    if (!window) {
        glfwTerminate();
        throw std::runtime_error("OpenGL window creation failed");
    }
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::GetIO().IniFilename = nullptr;
    static const ImWchar glyphs[] = {0x20, 0xff, 0x2000, 0x206f, 0};
    auto font_path = std::filesystem::absolute(argv[0]).parent_path() / "Roboto-Medium.ttf";
    if (std::filesystem::exists(font_path))
        ImGui::GetIO().Fonts->AddFontFromFileTTF(font_path.string().c_str(), 14, nullptr, glyphs);
    ImGui::StyleColorsDark();
    Input input{&app};
    glfwSetWindowUserPointer(window, &input);
    glfwSetCursorPosCallback(window, [](GLFWwindow *w, double x, double y) {
        auto &i = *static_cast<Input *>(glfwGetWindowUserPointer(w));
        i.app->cursor_x = x;
        i.app->cursor_y = y;
        if (i.button >= 0) {
            if (std::hypot(x - i.start_x, y - i.start_y) > 4)
                i.dragged = true;
            if (i.dragged) {
                bool rotate = i.button != GLFW_MOUSE_BUTTON_LEFT;
                if (glfwGetKey(w, GLFW_KEY_LEFT_SHIFT) == GLFW_PRESS ||
                    glfwGetKey(w, GLFW_KEY_RIGHT_SHIFT) == GLFW_PRESS)
                    rotate = !rotate;
                i.app->drag(x - i.x, y - i.y, rotate);
            }
        }
        i.x = x;
        i.y = y;
    });
    glfwSetScrollCallback(window, [](GLFWwindow *w, double, double dy) {
        if (!ImGui::GetIO().WantCaptureMouse)
            static_cast<Input *>(glfwGetWindowUserPointer(w))->app->wheel(dy);
    });
    glfwSetMouseButtonCallback(window, [](GLFWwindow *w, int button, int action, int) {
        auto &i = *static_cast<Input *>(glfwGetWindowUserPointer(w));
        auto &a = *i.app;
        if (action == GLFW_PRESS) {
            if (ImGui::GetIO().WantCaptureMouse)
                return;
            i.button = button;
            glfwGetCursorPos(w, &i.x, &i.y);
            i.start_x = i.x;
            i.start_y = i.y;
            i.dragged = false;
            if (a.editing < 0) {
                auto hit = a.pick(i.x, i.y);
                if (hit)
                    a.target = hit->point;
                else {
                    auto b = a.bounds(a.selected);
                    if (b.valid)
                        a.target = (b.min + b.max) * .5;
                }
            }
        } else if (action == GLFW_RELEASE && i.button == button) {
            i.button = -1;
            if (i.dragged)
                return;
            if (a.editing >= 0) {
                if (button == GLFW_MOUSE_BUTTON_LEFT)
                    a.finish_edit(true);
                else if (button == GLFW_MOUSE_BUTTON_RIGHT)
                    a.finish_edit(false);
            } else if (button == GLFW_MOUSE_BUTTON_LEFT) {
                auto h = a.pick(i.x, i.y, false, false);
                int picked = h ? h->object : -1;
                double now = glfwGetTime();
                a.selected = picked;
                if (picked >= 0 && picked == i.last_clicked && now - i.last_click <= .4 &&
                    std::hypot(i.x - i.last_click_x, i.y - i.last_click_y) <= 5) {
                    a.begin_edit();
                    i.last_clicked = -1;
                } else
                    i.last_clicked = picked;
                i.last_click = now;
                i.last_click_x = i.x;
                i.last_click_y = i.y;
            }
        }
    });
    glfwSetKeyCallback(window, [](GLFWwindow *w, int key, int, int action, int) {
        if (action != GLFW_PRESS || ImGui::GetIO().WantCaptureKeyboard)
            return;
        auto &input = *static_cast<Input *>(glfwGetWindowUserPointer(w));
        auto &a = *input.app;
        if (key == GLFW_KEY_R || key == GLFW_KEY_ENTER || key == GLFW_KEY_ESCAPE ||
            key == GLFW_KEY_U) {
            input.button = -1;
            input.last_clicked = -1;
        }
        if (key == GLFW_KEY_R)
            a.reset();
        else if (key == GLFW_KEY_O)
            a.toggle_projection();
        else if (key == GLFW_KEY_D)
            a.diagnostics = !a.diagnostics;
        else if (key == GLFW_KEY_F)
            a.free_camera = !a.free_camera;
        else if (key == GLFW_KEY_U)
            a.undo_edit();
        else if (key == GLFW_KEY_ENTER) {
            if (a.editing >= 0)
                a.finish_edit(true);
            else
                a.begin_edit();
        } else if (key == GLFW_KEY_ESCAPE)
            a.finish_edit(false);
    });
    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL2_Init();
    {
        MyOpenAxisIntegration integration(app, smoke, debug, url);
        if (diagnostic_smoke) {
            if (mode == "--smoke-diagnostics-ortho")
                app.toggle_projection();
            app.diagnostics = true;
            app.cursor_x = 850;
            app.cursor_y = 420;
            integration.collector.set_enabled(true);
            app.selected = 0;
            integration.session->receive({{"type", "motion_start"}, {"gesture_id", 1}});
            integration.session->receive(
                {{"type", "request"},
                 {"id", 1},
                 {"method", "navigation.query"},
                 {"params",
                  {{"gesture_id", 1},
                   {"values",
                    {"camera.pose", "world.orientation", "model.bounds", "selection.bounds",
                     "camera.view_target", "pick.viewport_center"}},
                   {"first",
                    {"pick.cursor.selection", "pick.cursor", "pick.viewport_center.selection"}}}}});
            integration.session->receive(
                {{"type", "camera.pivot"}, {"gesture_id", 1}, {"point", {0, 0, 0}}});
            integration.session->receive(
                {{"type", "object.pivot"}, {"gesture_id", 1}, {"point", {2, 0, 0}}});
            auto desired = pose_value(app.camera);
            desired["t"][0] = app.camera.t.x + .1;
            desired["type"] = "camera.pose";
            desired["gesture_id"] = 1;
            desired["seq"] = 1;
            integration.session->receive(desired);
        }
        int frames = 0;
        while (!glfwWindowShouldClose(window)) {
            glfwPollEvents();
            int old_width = app.width, old_height = app.height;
            glfwGetWindowSize(window, &app.width, &app.height);
            if (app.width != old_width || app.height != old_height) {
                ++app.generation;
                integration.session->context_changed();
            }
            glfwGetCursorPos(window, &app.cursor_x, &app.cursor_y);
            bool focused = glfwGetWindowAttrib(window, GLFW_FOCUSED) != 0;
            if (!focused)
                input.button = -1;
            integration.update(focused);
            int fw, fh;
            glfwGetFramebufferSize(window, &fw, &fh);
            glViewport(0, 0, fw, fh);
            auto diagnostic_frame = integration.collector.presentation();
            app.diagnostic_points.clear();
            if (diagnostic_frame.context == integration.context_key())
                for (auto &segment : diagnostic_frame.segments) {
                    app.diagnostic_points.push_back(segment.start);
                    app.diagnostic_points.push_back(segment.end);
                }
            app.render();
            ImGui_ImplOpenGL2_NewFrame();
            ImGui_ImplGlfw_NewFrame();
            ImGui::NewFrame();
            render_navigation_overlay(app, diagnostic_frame);
            auto *draw = ImGui::GetBackgroundDrawList();
            auto *font = ImGui::GetFont();
            draw->PushClipRect({0, 0}, {float(app.width), float(app.height)}, true);
            auto text = [&](ImVec2 position, ImU32 color, const std::string &value, float size = 16,
                            float wrap = 0) {
                draw->AddText(font, size, {position.x + 1, position.y + 1}, IM_COL32_BLACK,
                              value.c_str(), nullptr, wrap);
                draw->AddText(font, size, position, color, value.c_str(), nullptr, wrap);
            };
            if (app.editing >= 0)
                text({30, 20}, IM_COL32(255, 64, 191, 255), "EDITING OBJECT");
            float y = 50;
            float wrap = std::max(1.f, float(app.width) - 170);
            auto row = [&](const char *heading, const std::string &content) {
                text({30, y}, IM_COL32(102, 204, 255, 255), heading, 17);
                text({150, y}, IM_COL32_WHITE, content, 16, wrap);
                y += font->CalcTextSizeA(16, FLT_MAX, wrap, content.c_str()).y + 12;
            };
            row("MOUSE",
                app.editing >= 0
                    ? "Left-click: Accept    Right-click: Cancel\n"
                      "Left-drag: Translate    Middle/Right-drag: Rotate (Shift to swap)    Wheel: "
                      "Depth"
                    : "Click: Select    Double-click: Edit\n"
                      "Left-drag: Pan    Middle/Right-drag: Rotate (Shift to swap)    Wheel: Zoom");
            std::string controls = app.editing >= 0
                                       ? "Enter: Accept    Esc: Cancel    R: Reset scene"
                                       : "Enter: Edit selection    U: Undo    R: Reset scene";
            row("KEYBOARD", controls + "    O: Projection (" +
                                (app.camera.fov > 0 ? "Perspective" : "Orthographic") + ")");
#ifdef _WIN32
            const char *activation_key = "Win";
#elif defined(__APPLE__)
            const char *activation_key = app.free_camera ? "Cmd" : "Ctrl";
#else
            const char *activation_key = "Super";
#endif
            row("ROTATRIX:", integration.status_text() + "\n" + activation_key +
                                 " activates camera control (if not remapped)\n" + "F: Nav mode (" +
                                 (app.free_camera ? "Free Camera" : "Orbit") +
                                 ")    D: Diagnostics (" + (app.diagnostics ? "On" : "Off") + ")");
            draw->PopClipRect();
            ImGui::Render();
            ImGui_ImplOpenGL2_RenderDrawData(ImGui::GetDrawData());
            if (smoke && ++frames == 3) {
                std::vector<unsigned char> pixels(std::size_t(fw) * fh * 4);
                glReadPixels(0, 0, fw, fh, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
                for (std::size_t i = 0; i < pixels.size(); i += 4)
                    std::swap(pixels[i], pixels[i + 2]);
                std::ofstream out(argc > 2 ? argv[2] : "reference-smoke.bmp", std::ios::binary);
                auto u16 = [&](unsigned v) {
                    out.put(char(v));
                    out.put(char(v >> 8));
                };
                auto u32 = [&](unsigned v) {
                    u16(v & 65535);
                    u16(v >> 16);
                };
                out.write("BM", 2);
                u32(unsigned(54 + pixels.size()));
                u32(0);
                u32(54);
                u32(40);
                u32(fw);
                u32(fh);
                u16(1);
                u16(32);
                u32(0);
                u32(unsigned(pixels.size()));
                u32(0);
                u32(0);
                u32(0);
                u32(0);
                out.write(reinterpret_cast<char *>(pixels.data()), std::streamsize(pixels.size()));
                if (!out)
                    throw std::runtime_error("smoke image write failed");
                glfwSetWindowShouldClose(window, GLFW_TRUE);
            }
            glfwSwapBuffers(window);
            if (!smoke) {
                auto deadline = integration.scheduler.deadline();
                auto expiry = integration.collector.presentation().expires_at;
                if (expiry && (!deadline || *expiry < *deadline))
                    deadline = expiry;
                if (deadline) {
                    double delay = *deadline - diagnostic_time();
                    if (delay > 0)
                        glfwWaitEventsTimeout(delay);
                } else
                    glfwWaitEvents();
            }
        }
        app.finish_edit(false);
    }
    ImGui_ImplOpenGL2_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
