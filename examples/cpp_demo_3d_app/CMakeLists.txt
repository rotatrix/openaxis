find_package(OpenGL REQUIRED)
set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
FetchContent_Declare(glfw URL https://github.com/glfw/glfw/archive/refs/tags/3.4.tar.gz
  URL_HASH SHA256=c038d34200234d071fae9345bc455e4a8f2f544ab60150765d7704e08f3dac01)
FetchContent_Declare(imgui URL https://github.com/ocornut/imgui/archive/refs/tags/v1.91.9b.tar.gz
  URL_HASH SHA256=8e1bbc76c71d74fef2fb85db7e7ca8eba13d6a86623c54992b60162db554ffdb)
FetchContent_MakeAvailable(glfw imgui)
add_executable(openaxis_demo main.cpp application.cpp diagnostic_view.cpp
  ${imgui_SOURCE_DIR}/imgui.cpp ${imgui_SOURCE_DIR}/imgui_draw.cpp
  ${imgui_SOURCE_DIR}/imgui_tables.cpp ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl2.cpp)
target_include_directories(openaxis_demo PRIVATE ${imgui_SOURCE_DIR})
target_link_libraries(openaxis_demo PRIVATE OpenAxis::openaxis glfw OpenGL::GL)
if(UNIX AND NOT APPLE)
  # Keep the ordinary build executable usable outside a Linux build container.
  # Host display drivers and the C/C++ runtimes must still come from the host.
  set_target_properties(openaxis_demo PROPERTIES BUILD_RPATH "$ORIGIN")
  add_custom_command(TARGET openaxis_demo POST_BUILD
    COMMAND ${CMAKE_COMMAND} -DDEMO=$<TARGET_FILE:openaxis_demo>
      -P ${CMAKE_CURRENT_SOURCE_DIR}/copy-runtime.cmake)
endif()
if(OPENAXIS_BUILD_TESTS)
  add_executable(openaxis_demo_tests test_application.cpp application.cpp)
  target_link_libraries(openaxis_demo_tests PRIVATE OpenAxis::openaxis glfw OpenGL::GL)
  target_compile_definitions(openaxis_demo_tests PRIVATE SCENE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../demo_3d_scene")
  add_test(NAME openaxis_reference_scene COMMAND openaxis_demo_tests)
endif()
add_custom_command(TARGET openaxis_demo POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different
  ${CMAKE_CURRENT_SOURCE_DIR}/../demo_3d_scene/scene.json $<TARGET_FILE_DIR:openaxis_demo>/scene.json
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${imgui_SOURCE_DIR}/misc/fonts/Roboto-Medium.ttf $<TARGET_FILE_DIR:openaxis_demo>/Roboto-Medium.ttf
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${imgui_SOURCE_DIR}/docs/FONTS.md $<TARGET_FILE_DIR:openaxis_demo>/FONT-CREDITS.md)
