# OpenAxis C++ SDK

C++17 client SDK for OpenAxis 1.0. Requires CMake 3.24 or newer.

## Installation

```cmake
set(OPENAXIS_BUILD_TESTS OFF CACHE BOOL "")
set(OPENAXIS_BUILD_DEMO OFF CACHE BOOL "")
add_subdirectory(path/to/openaxis/cpp openaxis-build)
target_link_libraries(my_app PRIVATE OpenAxis::openaxis)
```

See [SDK installation](https://openaxis.rotatrix.com/guide/sdk-installation/#cpp)
for CMake FetchContent, release archives and dependencies. Use documentation matching your SDK revision;
checkout APIs may be newer than published packages.

## Documentation

- [Navigation quickstart and runnable demos](https://openaxis.rotatrix.com/guide/navigation-quickstart/#cpp)
- [Adapter contracts](https://openaxis.rotatrix.com/reference/navigation-hosts/)
- [Language support and current gaps](https://openaxis.rotatrix.com/reference/language-support/)

## License

Copyright © 2026 Icebound Flame LLC.

[Elastic License 2.0 or GPLv3, at your option](https://openaxis.rotatrix.com/LICENSE). See [legal notices](https://openaxis.rotatrix.com/LEGAL.md).
