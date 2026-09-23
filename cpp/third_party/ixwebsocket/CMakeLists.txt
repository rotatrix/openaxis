# OpenAxis private build of IXWebSocket; see UPSTREAM.md.
add_library(openaxis_ixwebsocket STATIC

    openaxis_ixwebsocket/IXBench.cpp
    openaxis_ixwebsocket/IXCancellationRequest.cpp
    openaxis_ixwebsocket/IXConnectionState.cpp
    openaxis_ixwebsocket/IXDNSLookup.cpp
    openaxis_ixwebsocket/IXExponentialBackoff.cpp
    openaxis_ixwebsocket/IXGetFreePort.cpp
    openaxis_ixwebsocket/IXGzipCodec.cpp
    openaxis_ixwebsocket/IXHttp.cpp
    openaxis_ixwebsocket/IXHttpClient.cpp
    openaxis_ixwebsocket/IXHttpServer.cpp
    openaxis_ixwebsocket/IXNetSystem.cpp
    openaxis_ixwebsocket/IXSelectInterrupt.cpp
    openaxis_ixwebsocket/IXSelectInterruptFactory.cpp
    openaxis_ixwebsocket/IXSelectInterruptPipe.cpp
    openaxis_ixwebsocket/IXSelectInterruptEvent.cpp
    openaxis_ixwebsocket/IXSetThreadName.cpp
    openaxis_ixwebsocket/IXSocket.cpp
    openaxis_ixwebsocket/IXSocketConnect.cpp
    openaxis_ixwebsocket/IXSocketFactory.cpp
    openaxis_ixwebsocket/IXSocketServer.cpp
    openaxis_ixwebsocket/IXSocketTLSOptions.cpp
    openaxis_ixwebsocket/IXStrCaseCompare.cpp
    openaxis_ixwebsocket/IXUdpSocket.cpp
    openaxis_ixwebsocket/IXUrlParser.cpp
    openaxis_ixwebsocket/IXUuid.cpp
    openaxis_ixwebsocket/IXUserAgent.cpp
    openaxis_ixwebsocket/IXWebSocket.cpp
    openaxis_ixwebsocket/IXWebSocketCloseConstants.cpp
    openaxis_ixwebsocket/IXWebSocketHandshake.cpp
    openaxis_ixwebsocket/IXWebSocketHttpHeaders.cpp
    openaxis_ixwebsocket/IXWebSocketPerMessageDeflate.cpp
    openaxis_ixwebsocket/IXWebSocketPerMessageDeflateCodec.cpp
    openaxis_ixwebsocket/IXWebSocketPerMessageDeflateOptions.cpp
    openaxis_ixwebsocket/IXWebSocketProxyServer.cpp
    openaxis_ixwebsocket/IXWebSocketServer.cpp
    openaxis_ixwebsocket/IXWebSocketTransport.cpp
)
target_compile_features(openaxis_ixwebsocket PRIVATE cxx_std_11)
target_include_directories(openaxis_ixwebsocket PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
set_target_properties(openaxis_ixwebsocket PROPERTIES
  POSITION_INDEPENDENT_CODE ON
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN ON)
# TLS and compression are deliberately disabled. Do not inherit USE_TLS,
# USE_ZLIB, BUILD_SHARED_LIBS, or other unrelated application cache options.
if(WIN32)
  target_link_libraries(openaxis_ixwebsocket PRIVATE wsock32 ws2_32 shlwapi)
  target_compile_definitions(openaxis_ixwebsocket PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
find_package(Threads REQUIRED)
target_link_libraries(openaxis_ixwebsocket PRIVATE Threads::Threads)
